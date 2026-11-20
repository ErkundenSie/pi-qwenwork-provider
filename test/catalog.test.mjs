import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchCatalog, outputTokenLimit, parseCatalog } from '../lib/catalog.mjs'
import { createQwenworkProvider, PROVIDER_ID } from '../lib/provider.mjs'

const runtime = { version: '2.1.0' }
const credential = { type: 'oauth', access: 'mock-access', refresh: 'mock-refresh', expires: 4e12, uid: 'mock-user', machineId: 'mock-device' }
const url = 'https://gateway.qwenwork.cn/api/desktop/chat-modes'
const row = (key, fields = {}) => ({ key, enable: true, source: 'system', format: 'openai/chat-completions', ...fields })
const payload = (...catalog) => ({ schema_version: 2, catalog })
const ids = provider => provider.getModels().map(model => model.id)

function harness(stored) {
  return {
    get stored() { return stored },
    async refresh(provider, options = {}) {
      await provider.refreshModels({
        credential, stored, signal: new AbortController().signal, allowNetwork: false,
        async publish({ persist, update }) {
          if (persist) stored = structuredClone(persist)
          update?.()
          return true
        },
        ...options,
      })
    },
  }
}

test('catalog validates enabled hosted chat models and preserves Pi tier IDs', () => {
  const catalog = parseCatalog({ data: payload(
    row('flash'), row('qwork-auto'), row('pro'),
    row('fresh', { i18n: { display_name: { zh: '新模型', en: 'New' } }, is_vl: true, is_reasoning: true, format: 'anthropic/messages' }),
    row('disabled', { enable: false }), row('hidden', { visible: false }),
    row('custom', { source: 'custom' }), row('image', { format: 'image/generate' }), row('../bad'),
    row('bad-label', { display_name: 'line\nbreak' }),
  ) })
  assert.deepEqual([...catalog.keys()], ['qwork-auto', 'qwork-advanced', 'fresh', 'bad-label'])
  assert.equal(catalog.get('qwork-auto').key, 'flash')
  assert.equal(catalog.get('qwork-advanced').key, 'pro')
  assert.deepEqual(catalog.get('fresh'), { id: 'fresh', key: 'fresh', name: '新模型', reasoning: true, vision: true, maxOutputTokens: undefined })
  assert.equal(catalog.get('bad-label').name, 'bad-label')
  assert.throws(() => parseCatalog({ schema_version: 3, catalog: [] }), /格式/)
  assert.throws(() => parseCatalog(payload(row('off', { enable: false }))), /没有返回可用/)
})

test('uses the desktop output fallback and explicit catalog caps, including across cache upgrades', async () => {
  const provider = createQwenworkProvider({}, {
    runtimeProvider: () => runtime,
    fetchImpl: async () => Response.json(payload(
      row('deepseek-flash', { max_input_tokens: 1000000 }),
      row('capped', { max_output_tokens: 16384 }),
      row('camel', { maxOutputTokens: 65536 }),
      row('invalid', { max_output_tokens: -1 }),
    )),
  })
  assert.ok(provider.getModels().every(m => m.contextWindow === 1_000_000))
  assert.equal(provider.getModels().find(m => m.id === 'deepseek-flash').maxTokens, 32768)
  const state = harness()
  await state.refresh(provider, { allowNetwork: true })
  const offline = createQwenworkProvider({}, { fetchImpl: () => assert.fail('cache-only I/O') })
  const entry = state.stored
  // Old caches may contain adapter defaults rather than catalog limits.
  Object.assign(entry.models.find(m => m.id === 'deepseek-flash'), { contextWindow: 131072, maxTokens: 8192 })
  await harness(entry).refresh(offline)
  const models = offline.getModels()
  assert.deepEqual(models.map(m => [m.id, m.contextWindow, m.maxTokens]), [
    ['deepseek-flash', 1_000_000, 32768],
    ['capped', 1_000_000, 16384],
    ['camel', 1_000_000, 65536],
    ['invalid', 1_000_000, 32768],
  ])
  assert.equal(outputTokenLimit({ maxOutputTokens: 393216 }), 131072)
})

test('uses host cache across instances without mixing accounts; force refresh replaces and failure preserves it', async () => {
  let calls = 0
  let reply = () => Response.json(payload(row('flash'), row('fresh')))
  const fetchImpl = async (input, init) => {
    calls++
    assert.equal(input, url)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer mock-access')
    assert.ok(!JSON.stringify(init).includes(credential.refresh))
    return reply()
  }
  const first = createQwenworkProvider({}, { fetchImpl, runtimeProvider: () => runtime })
  const state = harness()
  await state.refresh(first, { allowNetwork: true })
  assert.deepEqual(ids(first), ['qwork-auto', 'fresh'])
  const stored = state.stored
  for (const privateValue of Object.values(credential).filter(value => typeof value === 'string' && value.startsWith('mock-'))) {
    assert.ok(!JSON.stringify(stored).includes(privateValue))
  }
  const reopened = createQwenworkProvider({}, { fetchImpl, runtimeProvider: () => runtime })
  await state.refresh(reopened)
  await state.refresh(reopened, { allowNetwork: true })
  assert.equal(calls, 1)
  assert.deepEqual(ids(reopened), ids(first))

  reply = () => new Response(null, { status: 503 })
  await assert.rejects(state.refresh(reopened, { allowNetwork: true, force: true }), /503/)
  assert.deepEqual(state.stored, stored)
  assert.deepEqual(ids(reopened), ['qwork-auto', 'fresh'])
  reply = () => Response.json(payload(row('pro'), row('replacement')))
  await state.refresh(reopened, { allowNetwork: true, force: true })
  assert.deepEqual(ids(reopened), ['qwork-advanced', 'replacement'])

  await state.refresh(reopened, { credential: { ...credential, organizationId: 'other-org' } })
  assert.equal(ids(reopened).length, 13)
  await state.refresh(reopened, { credential: undefined })
  assert.ok(!ids(reopened).includes('replacement'))
})

test('successful browser login supplies a catalog to the next cache-only host refresh', async () => {
  const provider = createQwenworkProvider({}, {
    runtimeProvider: () => runtime,
    async fetchImpl(input) {
      const path = new URL(input).pathname
      if (path.endsWith('/poll')) return Response.json({ token: credential.access, refresh_token: credential.refresh })
      if (path === '/api/desktop/chat-modes') return Response.json(payload(row('fresh')))
      return Response.json({ user: { id: credential.uid } })
    },
  })
  const loggedIn = await provider.auth.oauth.login({ notify() {}, signal: new AbortController().signal })
  const state = harness()
  await state.refresh(provider, { credential: loggedIn })
  const reopened = createQwenworkProvider({})
  await state.refresh(reopened, { credential: loggedIn })
  assert.deepEqual(ids(reopened), ['fresh'])
})

test('honors cancellation and rejects oversized or malformed catalog responses', async () => {
  const controller = new AbortController()
  const request = fetchCatalog(credential, runtime, {
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  })
  controller.abort()
  await assert.rejects(request, { name: 'AbortError' })
  await assert.rejects(fetchCatalog(credential, runtime, { fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1)) }), /大小限制/)
  await assert.rejects(fetchCatalog(credential, runtime, { fetchImpl: async () => new Response('{') }), /有效 JSON/)
})

test('the real Pi SDK restores dynamic models from its model store', { skip: !process.env.PI_QWENWORK_SDK_ROOT }, async () => {
  const piAi = file => pathToFileURL(resolve(process.env.PI_QWENWORK_SDK_ROOT, 'node_modules/@earendil-works/pi-ai/dist', file)).href
  const { createModels } = await import(piAi('models.js'))
  const { InMemoryModelsStore } = await import(piAi('models-store.js'))
  const { InMemoryCredentialStore } = await import(piAi('auth/credential-store.js'))
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(PROVIDER_ID, async () => credential)
  const modelsStore = new InMemoryModelsStore()
  const runtimeOptions = { modelsStore, credentials }
  const first = createModels(runtimeOptions)
  first.setProvider(createQwenworkProvider({}, {
    runtimeProvider: () => runtime,
    fetchImpl: async () => Response.json(payload(row('flash'), row('fresh'))),
  }))
  const refreshed = await first.refresh({ force: true })
  assert.equal(refreshed.errors.size, 0)
  assert.deepEqual(first.getModels(PROVIDER_ID).map(model => model.id), ['qwork-auto', 'fresh'])
  const second = createModels(runtimeOptions)
  second.setProvider(createQwenworkProvider({}, { fetchImpl: () => assert.fail('cache-only I/O') }))
  const restored = await second.refresh({ allowNetwork: false })
  assert.equal(restored.errors.size, 0)
  assert.deepEqual((await second.getAvailable(PROVIDER_ID)).map(model => model.id), ['qwork-auto', 'fresh'])
})
