import { MODELS } from './constants.mjs'
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

export function createProviderConfig(adapter, {
  runtimeProvider = getRuntime,
  signer = prepareQwenworkInfer,
  fetchImpl = (...args) => globalThis.fetch(...args),
  loginOptions = {},
} = {}) {
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
          signer, fetchImpl, signal,
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

  return {
    name: NAME,
    baseUrl: ADAPTER_URL,
    api: API,
    models: Object.entries(MODELS).map(([id, info]) => ({
      id,
      name: info.name,
      reasoning: info.reasoning,
      input: info.modalities.input,
      contextWindow: info.limit.context,
      maxTokens: info.limit.output,
      // QwenWork bills in credits; there is no verified per-token USD price.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    oauth: {
      name: NAME,
      async login(callbacks) {
        let flow
        let tokens
        try {
          callbacks.signal?.throwIfAborted()
          flow = startLogin(runtimeProvider())
          callbacks.onAuth({ url: flow.url, instructions: '在新标签页完成千问办公授权，然后返回此页等待自动完成；无需粘贴验证码。' })
          tokens = await waitForLogin(flow, { ...loginOptions, fetchImpl, signal: callbacks.signal })
          return await finishLogin(flow, tokens, { fetchImpl, signal: callbacks.signal })
        } catch (e) {
          if (callbacks.signal?.aborted) throw callbacks.signal.reason
          throw new Error(safeMessage(e, [flow?.verifier, flow?.nonce, tokens?.token, tokens?.device_token, tokens?.access_token, tokens?.refresh_token]))
        }
      },
      async refreshToken(credentials, signal) {
        try {
          return await renewAuth(credentials, runtimeProvider(), { fetchImpl, signal })
        } catch (e) {
          if (signal?.aborted) throw signal.reason
          const error = new Error(safeMessage(e, [credentials?.refresh, credentials?.access]))
          if (e?.signIn === 'expired') error.message = '千问办公的插件授权已失效，请在 Pi Web 重新登录。'
          throw error
        }
      },
      getApiKey: encodeAuth,
    },
    streamSimple(model, context, options) {
      return adapter.streamSimple({ ...model, baseUrl: ADAPTER_URL, compat }, context, {
        ...options,
        apiKey: 'qwenwork-in-process',
        maxRetries: 0,
        fetch: localTransport(model.id, options?.apiKey),
      })
    },
  }
}

function errorFromRuntimeOrNetwork(error) {
  if (typeof error?.message === 'string' && /ABI|必要导出|缺少.*导入/.test(error.message)) {
    return new ProviderError('千问办公签名组件不兼容。请运行 npm run doctor 查看组件版本。', 400, 'configuration_error')
  }
  return new ProviderError('千问办公连接失败；请检查网络或运行 npm run doctor 检查签名组件。')
}
