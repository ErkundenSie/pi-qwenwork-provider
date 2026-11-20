import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createProviderConfig, PROVIDER_ID } from '../lib/provider.mjs'

const runtime = { version: '2.1.0', releaseVersion: '2.1.0-26111906' }
const credentials = { access: 'test-access-secret', refresh: 'test-refresh-secret', uid: '42', machineId: 'test-device', email: 'test@example.invalid' }
const chatPath = 'https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation'
const user = { role: 'user', content: '你好', timestamp: 1 }

test('registers both tiers and all desktop designated models without I/O', () => {
  const fail = () => assert.fail('eager I/O')
  const config = createProviderConfig({}, { runtimeProvider: fail, fetchImpl: fail })
  assert.equal(PROVIDER_ID, 'qwenwork-browser')
  assert.deepEqual(config.models.map(model => model.id), [
    'qwork-auto', 'qwork-advanced', 'qwen4-max', 'qwen3.8-max-preview', 'qwen3.8-flash',
    'ling-3.1-flash', 'deepseek-flash', 'deepseek-v4-pro', 'glm-5.3', 'glm-5.3-flash',
    'kimi-k3.1-pro', 'minimax-m3.1-flash', 'step-5-preview',
  ])
  const model = id => config.models.find(model => model.id === id)
  assert.equal(model('deepseek-flash').name, 'DeepSeek-V4.1-Flash')
  assert.deepEqual(model('qwen4-max').input, ['text', 'image'])
  assert.deepEqual(model('ling-3.1-flash').input, ['text'])
  assert.equal(config.name, 'QwenWork (OAuth)')
  assert.equal(config.oauth.name, config.name)
  assert.notEqual(config.api, 'openai-completions')
})

test('Pi Web style auth_url plus polling requires no pasted code and leaves the App login untouched', async () => {
  let link, seen = 0
  const config = createProviderConfig({}, {
    runtimeProvider: () => runtime,
    loginOptions: { interval: 1 },
    async fetchImpl(input, init) {
      const url = new URL(input)
      assert.equal(url.origin, 'https://gateway.qwenwork.cn')
      assert.equal(init.redirect, 'error')
      if (url.pathname.endsWith('/poll')) {
        assert.ok(link, 'the UI gets its link before polling')
        assert.equal(url.searchParams.get('nonce'), link.searchParams.get('nonce'))
        assert.equal(createHash('sha256').update(url.searchParams.get('verifier')).digest('base64url'), link.searchParams.get('challenge'))
        if (seen++ === 0) return new Response(null, { status: 404 })
        return Response.json({ token: credentials.access, refresh_token: credentials.refresh, expires_in: 3600 })
      }
      assert.equal(init.headers.Authorization, 'Bearer ' + credentials.access)
      return Response.json({ user: { id: credentials.uid, email: credentials.email } })
    },
  })
  const auth = await config.oauth.login({
    onAuth: ({ url }) => { link = new URL(url) },
    onPrompt: () => assert.fail('requires user input'),
  })
  assert.equal(auth.machineId, link.searchParams.get('machine_id'))
  assert.equal(auth.uid, credentials.uid)
  assert.equal(auth.refresh, credentials.refresh)
  const key = config.oauth.getApiKey(auth)
  assert.ok(!Buffer.from(key.split(':')[1], 'base64url').toString().includes(credentials.refresh))
})

test('login cancellation prevents any subsequent poll', async () => {
  const ctrl = new AbortController()
  const config = createProviderConfig({}, { runtimeProvider: () => runtime, fetchImpl: () => assert.fail('sent after abort') })
  await assert.rejects(config.oauth.login({
    signal: ctrl.signal,
    onAuth: () => ctrl.abort(),
  }), { name: 'AbortError' })
})

test('expired authorization is sanitized and prompts for browser re-login', async () => {
  const config = createProviderConfig({}, {
    runtimeProvider: () => runtime,
    fetchImpl: async () => Response.json({ error: { message: credentials.refresh } }, { status: 401 }),
  })
  await assert.rejects(config.oauth.refreshToken(credentials, new AbortController().signal), /重新登录/)
})

function fakeAdapter() {
  return {
    streamSimple(model, _context, options) {
      assert.equal(options.apiKey, 'qwenwork-in-process')
      return options.fetch(model.baseUrl + '/chat/completions', {
        method: 'POST', body: JSON.stringify({ model: model.id, messages: [user] }),
      })
    },
  }
}

test('missing login is an HTTP 401 and never sends an inference request', async () => {
  const config = createProviderConfig(fakeAdapter(), { fetchImpl: () => assert.fail('request without auth') })
  const response = await config.streamSimple({ id: 'qwork-auto' }, {}, {})
  assert.equal(response.status, 401)
  assert.match(await response.text(), /登录/)
})

test('an unexpected signed destination is rejected before transmitting anything', async () => {
  const config = createProviderConfig(fakeAdapter(), {
    runtimeProvider: () => runtime,
    signer: async () => ({ url: 'https://example.invalid/' }),
    fetchImpl: () => assert.fail('request left the allowlist'),
  })
  const response = await config.streamSimple({ id: 'qwork-auto' }, {}, { apiKey: config.oauth.getApiKey(credentials) })
  assert.equal(response.status, 502)
  assert.match(await response.text(), /拒绝/)
})

const frame = body => 'data: ' + JSON.stringify({ body: JSON.stringify(body) }) + '\n\n'
const done = 'data: {"body":"[DONE]"}\n\ndata: {"timing":25}\n\n'
const chunk = (delta, finish_reason = null) => ({
  id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1,
  choices: [{ index: 0, delta, finish_reason }],
})

test('uses the selected model key in the signed payload and headers for every model', async () => {
  const config = createProviderConfig(fakeAdapter(), {
    runtimeProvider: () => runtime,
    async signer(input) {
      const body = JSON.parse(input.body)
      const model = config.models.find(model => model.id === input.modelKey)
      assert.ok(model)
      assert.equal(body.model_config.key, model.id)
      assert.equal(body.chat_context.extra.modelConfig.key, model.id)
      assert.equal(body.model_config.is_vl, model.input.includes('image'))
      return { url: chatPath, body: input.modelKey, headers: {} }
    },
    async fetchImpl(url, init) {
      assert.equal(url, chatPath)
      assert.equal(init.headers['X-Model-Key'], init.body)
      return new Response(frame(chunk({ content: 'ok' }, 'stop')) + done)
    },
  })
  for (const model of config.models) {
    const response = await config.streamSimple(model, {}, { apiKey: config.oauth.getApiKey(credentials) })
    assert.equal(response.status, 200, model.id)
    const raw = (await response.text()).split('\n').find(line => line.startsWith('data: {'))
    assert.equal(JSON.parse(raw.slice(6)).model, model.id)
  }
})

let compatUrl
const sdkRoot = process.env.PI_QWENWORK_SDK_ROOT
try {
  const require = createRequire(sdkRoot ? resolve(sdkRoot, 'package.json') : import.meta.url)
  compatUrl = pathToFileURL(require.resolve('@earendil-works/pi-ai/dist/compat.js')).href
} catch {
  // pi-ai exposes compat via the ESM import condition only.
  if (sdkRoot) compatUrl = pathToFileURL(resolve(sdkRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js')).href
}
const sdk = { skip: !compatUrl && 'Set PI_QWENWORK_SDK_ROOT to the pi-web package directory to test with the host SDK' }

async function sdkConfig(sse, inspect = () => {}) {
  const { openAICompletionsApi } = await import(compatUrl)
  return createProviderConfig(openAICompletionsApi(), {
    runtimeProvider: () => runtime,
    async signer(input) {
      assert.equal(input.accessToken, credentials.access)
      assert.ok(!JSON.stringify(input).includes(credentials.refresh))
      inspect(JSON.parse(input.body))
      return { url: chatPath, body: 'signed-fixture', headers: { Authorization: 'Bearer COSY.fake' } }
    },
    async fetchImpl(url, init) {
      assert.equal(url, chatPath)
      assert.equal(init.headers.Authorization, 'Bearer COSY.fake')
      assert.equal(init.body, 'signed-fixture')
      assert.equal(init.redirect, 'error')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
}

function run(config, messages = [user], options = {}) {
  const model = { ...config.models[0], baseUrl: config.baseUrl, provider: PROVIDER_ID, api: config.api }
  return config.streamSimple(model, { messages }, { apiKey: config.oauth.getApiKey(credentials), ...options }).result()
}

test('host SDK streams Chinese text, thinking and upstream usage through the in-process adapter', sdk, async () => {
  const config = await sdkConfig(frame(chunk({ reasoning_content: '思考' })) +
    frame(chunk({ content: '你好' }, 'stop')) +
    frame({ ...chunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + done,
    body => assert.equal(body.messages.at(-1).content, '你好'))
  let payload, status, count = 0
  const result = await run(config, [user], {
    onPayload: value => { payload = value },
    onResponse: response => { status = response.status },
    onProviderStreamEvent: () => { count++ },
  })
  assert.equal(payload.model, 'qwork-auto')
  assert.equal(status, 200)
  assert.equal(count, 3)
  assert.equal(result.stopReason, 'stop')
  assert.equal(result.content.find(block => block.type === 'thinking').thinking, '思考')
  assert.equal(result.content.find(block => block.type === 'text').text, '你好')
  assert.equal(result.usage.totalTokens, 15)
})

test('host SDK parses fragmented tool args and sends a matching tool result on the next turn', sdk, async () => {
  const tool = { name: 'lookup', description: 'A mock lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } }
  const system = { role: 'system', content: 'Use the lookup tool.', toolsAdded: [tool], timestamp: 1 }
  const config = await sdkConfig(
    frame(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"key":' } }] })) +
    frame(chunk({ tool_calls: [{ index: 0, function: { arguments: '"example"}' } }] }, 'tool_calls')) + done,
    body => assert.equal(body.tools[0].function.name, 'lookup'))
  const first = await run(config, [system, user])
  assert.equal(first.stopReason, 'toolUse', first.errorMessage)
  const call = first.content.find(block => block.type === 'toolCall')
  assert.deepEqual(call.arguments, { key: 'example' })
  const follow = await sdkConfig(frame(chunk({ content: '完成' }, 'stop')) + done, body => {
    const requestCall = body.messages.find(message => message.role === 'assistant').tool_calls[0]
    assert.deepEqual(JSON.parse(requestCall.function.arguments), { key: 'example' })
    assert.equal(body.messages.at(-1).role, 'tool')
    assert.equal(body.messages.at(-1).tool_call_id, requestCall.id)
  })
  const last = await run(follow, [system, user, first, {
    role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 2,
  }])
  assert.equal(last.content[0]?.text, '完成', last.errorMessage)
})

test('host SDK sees quota errors before content and refuses a truncated stream', sdk, async () => {
  const quota = await run(await sdkConfig(frame(chunk({ role: 'assistant' })) +
    frame({ code: 'INSUFFICIENT_CREDITS', message: '积分不足' })))
  assert.equal(quota.stopReason, 'error')
  assert.match(quota.errorMessage, /429|积分不足/)
  const truncated = await run(await sdkConfig(frame(chunk({ content: '片段' })) + done))
  assert.equal(truncated.stopReason, 'error')
  assert.match(truncated.errorMessage, /未返回完成标记/)
  const lateError = await run(await sdkConfig(frame(chunk({ content: '片段' })) +
    frame({ code: 'INVALID_TOKEN', message: `invalid token: ${credentials.access}` })))
  assert.equal(lateError.stopReason, 'error')
  assert.doesNotMatch(lateError.errorMessage, /test-access-secret/)
})
