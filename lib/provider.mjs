import { CATALOG_MAX_AGE, FALLBACK_CATALOG, catalogScope, fetchCatalog, outputTokenLimit, restoreCatalog } from './catalog.mjs'
import { ADAPTER_CONTEXT_WINDOW } from './constants.mjs'
import { finishLogin, renewAuth, startLogin, waitForLogin } from './account.mjs'
import { chatResponse } from './chat.mjs'
import { redact, errorResponse, ProviderError } from './errors.mjs'
import { getRuntime } from './runtime-config.mjs'
import { prepareQwenworkInfer } from './wasm.mjs'

export const PROVIDER_ID = 'qwenwork-browser'
const NAME = 'QwenWork (OAuth)'
// A synthetic OpenAI SDK destination. The injected fetch handles it in memory;
// there is no listener, and there is deliberately no real endpoint to fall back to.
const ADAPTER_URL = 'https://qwenwork-pi.invalid/v1'
const CHAT_URL = ADAPTER_URL + '/chat/completions'
const API = 'qwenwork-browser-chat'
const PREFIX = 'qwb1:'
const fields = ['access', 'uid', 'machineId', 'name', 'email', 'organizationId']
const required = fields.slice(0, 3)
const compat = {
  supportsDeveloperRole: false,
  supportsStore: false,
  maxTokensField: 'max_tokens',
  supportsReasoningEffort: true,
  supportsFinishReason: true,
  supportsStrictMode: false,
}

function chatAuth(credentials) {
  if (!required.every(field => typeof credentials?.[field] === 'string' && credentials[field])) {
    throw new ProviderError(`请在 Pi Web 的模型供应商中登录「${NAME}」`, 401, 'authentication_error')
  }
  return Object.fromEntries(fields.filter(field => typeof credentials[field] === 'string').map(field => [field, credentials[field]]))
}

function encodeAuth(credentials) {
  // The Pi streaming contract passes OAuth request credentials via options.apiKey.
  // Keep refresh credentials in auth.json; never put this envelope in an HTTP header.
  return PREFIX + Buffer.from(JSON.stringify(chatAuth(credentials))).toString('base64url')
}

function decodeAuth(value) {
  let credentials
  if (typeof value === 'string' && value.startsWith(PREFIX) && value.length < 65536) {
    try { credentials = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8')) } catch {}
  }
  return chatAuth(credentials)
}

function safeMessage(error, secrets) {
  let message = String(error instanceof Error ? error.message : error)
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[已隐藏]')
  return redact(message)
}

function piModel(model) {
  const { id, name, reasoning, vision } = model
  return {
    type: 'chat', id, name, reasoning, api: API, provider: PROVIDER_ID, baseUrl: ADAPTER_URL,
    input: vision ? ['text', 'image'] : ['text'],
    contextWindow: ADAPTER_CONTEXT_WINDOW, maxTokens: outputTokenLimit(model),
    // QwenWork bills in credits; there is no verified per-token USD price.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export function createQwenworkProvider(adapter, {
  runtimeProvider = getRuntime,
  signer = prepareQwenworkInfer,
  fetchImpl = (...args) => globalThis.fetch(...args),
  loginOptions = {},
} = {}) {
  let current
  let pendingLoginCatalog

  async function refreshModels(context) {
    const auth = context.credential?.type === 'oauth' ? context.credential : undefined
    const scope = catalogScope(auth)
    const cached = restoreCatalog(context.stored, scope, PROVIDER_ID, API)
    const fromLogin = pendingLoginCatalog && pendingLoginCatalog.scope === scope ? pendingLoginCatalog : undefined

    async function publishCatalog(entry, persist) {
      const publication = { update: () => { current = entry } }
      if (persist) {
        publication.persist = {
          qwenworkCatalogScope: entry.scope,
          checkedAt: entry.checkedAt,
          models: [...entry.models.values()].map(model => ({
            ...piModel(model), qwenworkKey: model.key, qwenworkMaxOutputTokens: model.maxOutputTokens,
          })),
        }
      }
      return context.publish(publication)
    }

    if (fromLogin && (!cached || fromLogin.checkedAt > cached.checkedAt)) {
      if (!(await publishCatalog(fromLogin, true))) return
      if (pendingLoginCatalog === fromLogin) pendingLoginCatalog = undefined
    } else if (!(await publishCatalog(cached, false))) {
      return
    }

    if (!context.allowNetwork || !scope || !auth?.access) return
    const age = Date.now() - current?.checkedAt
    if (!context.force && age >= 0 && age < CATALOG_MAX_AGE) return
    let models
    try {
      models = await fetchCatalog(auth, runtimeProvider(), { fetchImpl, signal: context.signal })
    } catch (error) {
      context.signal.throwIfAborted()
      throw new Error(safeMessage(error, [auth.access, auth.refresh]))
    }
    await publishCatalog({ scope, models, checkedAt: Date.now() }, true)
  }

  function localTransport(modelId, key) {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      let auth
      try {
        signal?.throwIfAborted()
        if (url !== CHAT_URL || method.toUpperCase() !== 'POST') {
          throw new ProviderError('千问办公适配器拒绝了非预期请求地址', 502)
        }
        auth = decodeAuth(key)
        const catalog = current?.scope === catalogScope(auth) ? current.models : FALLBACK_CATALOG
        const selected = catalog.get(modelId)
        if (!selected) throw new ProviderError('该模型不在千问办公当前目录中，请刷新模型目录或切换模型', 400, 'invalid_request_error')
        let request
        try {
          request = init?.body != null ? JSON.parse(init.body) : await input.json()
        } catch {
          throw new ProviderError('千问办公适配器收到无效的请求体', 400, 'invalid_request_error')
        }
        let runtime
        try { runtime = runtimeProvider() } catch (e) {
          throw new ProviderError(safeMessage(e, []), 400, 'configuration_error')
        }
        return await chatResponse({ ...request, model: modelId, stream: true }, auth, runtime, {
          selected, signer, fetchImpl, signal,
        })
      } catch (e) {
        if (signal?.aborted) throw signal.reason
        const error = e instanceof ProviderError
          ? new ProviderError(safeMessage(e, [auth?.access, key]), e.status, e.code)
          : e?.name === 'TimeoutError'
            ? new ProviderError('千问办公请求超时', 504)
            : errorFromRuntimeOrNetwork(e)
        return errorResponse(error)
      }
    }
  }

  const oauth = {
    name: NAME,
    isSubscription: true,
    async login({ notify, signal }) {
      let flow
      let tokens
      let auth
      try {
        signal?.throwIfAborted()
        flow = startLogin(runtimeProvider())
        notify({ type: 'auth_url', url: flow.url, instructions: '在新标签页完成千问办公授权，然后返回此页等待自动完成；无需粘贴验证码。' })
        tokens = await waitForLogin(flow, { ...loginOptions, fetchImpl, signal })
        auth = await finishLogin(flow, tokens, { fetchImpl, signal })
      } catch (e) {
        if (signal?.aborted) throw signal.reason
        throw new Error(safeMessage(e, [flow?.verifier, flow?.nonce, tokens?.token, tokens?.device_token, tokens?.access_token, tokens?.refresh_token]))
      }
      if (process.env.PI_OFFLINE === undefined) {
        try {
          const models = await fetchCatalog(auth, flow.runtime, { fetchImpl, signal })
          // The host's next cache-only refresh will see the stored credential and publish it.
          pendingLoginCatalog = { scope: catalogScope(auth), models, checkedAt: Date.now() }
        } catch {
          // A catalog outage must not fail a successful login.
        }
      }
      signal?.throwIfAborted()
      return auth
    },
    async refresh(credentials, signal) {
      try {
        return await renewAuth(credentials, runtimeProvider(), { fetchImpl, signal })
      } catch (e) {
        if (signal?.aborted) throw signal.reason
        const error = new Error(safeMessage(e, [credentials?.refresh, credentials?.access]))
        if (e?.signIn === 'expired') error.message = '千问办公的插件授权已失效，请在 Pi Web 重新登录。'
        throw error
      }
    },
    async toAuth(credentials) { return { apiKey: encodeAuth(credentials) } },
  }

  function streamSimple(model, context, options) {
    return adapter.streamSimple({ ...model, baseUrl: ADAPTER_URL, compat }, context, {
      ...options,
      apiKey: 'qwenwork-in-process',
      maxRetries: 0,
      fetch: localTransport(model.id, options?.apiKey),
    })
  }

  return {
    id: PROVIDER_ID,
    name: NAME,
    baseUrl: ADAPTER_URL,
    auth: { oauth },
    getModels: () => [...(current?.models ?? FALLBACK_CATALOG).values()].map(piModel),
    refreshModels,
    stream: streamSimple,
    streamSimple,
  }
}

// Keep Pi Web's existing extension registration shape while using Pi's
// generation-checked model-store publication from the refresh context.
export function createProviderConfig(adapter, options) {
  const provider = createQwenworkProvider(adapter, options)
  const oauth = provider.auth.oauth
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: API,
    models: provider.getModels(),
    oauth: {
      name: oauth.name,
      isSubscription: oauth.isSubscription,
      login: callbacks => oauth.login({
        signal: callbacks.signal,
        notify: ({ url, instructions }) => callbacks.onAuth({ url, instructions }),
      }),
      refreshToken: oauth.refresh,
      getApiKey: encodeAuth,
    },
    async refreshModels(context) {
      await provider.refreshModels(context)
      return provider.getModels()
    },
    streamSimple: provider.streamSimple,
  }
}

function errorFromRuntimeOrNetwork(error) {
  if (typeof error?.message === 'string' && /ABI|必要导出|缺少.*导入/.test(error.message)) {
    return new ProviderError('千问办公签名组件不兼容。请运行 npm run doctor 查看组件版本。', 400, 'configuration_error')
  }
  return new ProviderError('千问办公连接失败；请检查网络或运行 npm run doctor 检查签名组件。')
}
