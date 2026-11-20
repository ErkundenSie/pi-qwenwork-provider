import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { discoverRuntime, runtimeCandidates } from '../lib/runtime.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'
import { upstreamError, redact } from '../lib/errors.mjs'

test('runtime discovery considers explicit paths, macOS and Windows installations', () => {
  assert.equal(runtimeCandidates({ env: { QWENWORK_WASM_PATH: '/custom/file.wasm' }, platform: 'linux', home: '/empty' })[0], '/custom/file.wasm')
  assert.ok(runtimeCandidates({ env: {}, platform: 'darwin', home: '/test' }).includes('/Applications/QwenWorkCN.app/Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm'))
  assert.ok(runtimeCandidates({ env: { LOCALAPPDATA: 'C:/Users/test/AppData/Local' }, platform: 'win32', home: 'C:/Users/test' }).some(file => file.includes('QwenWorkCN')))
})
test('missing runtime is actionable and never reads a credential store', () => {
  assert.throws(() => discoverRuntime({ env: {}, platform: 'unsupported', home: '/unused', bundledRoot: null }), /不读取 App 的登录文件/)
})
test('explicit component paths precede bundled and system installations', () => {
  const candidates = runtimeCandidates({
    env: { QWENWORK_WASM_PATH: '/custom/file.wasm', QWENWORK_APP_PATH: '/custom/app' },
    platform: 'linux', home: '/unused', bundledRoot: '/bundled',
  })
  assert.deepEqual(candidates.slice(0, 4), [
    '/custom/file.wasm',
    '/custom/app/qoder-auth-wasm/qoder_auth_wasm_bg.wasm',
    '/custom/app/resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm',
    '/bundled/qoder-auth-wasm/qoder_auth_wasm_bg.wasm',
  ])
  assert.ok(candidates.indexOf('/opt/QwenWorkCN/resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm') > 3)
})
test('bundled component supplies its source version and honors version overrides', () => {
  const runtime = discoverRuntime({ env: {} })
  assert.equal(runtime.wasmPath, fileURLToPath(new URL('../.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm', import.meta.url)))
  assert.equal(runtime.version, '2.1.0')
  assert.equal(runtime.releaseVersion, '2.1.0-26111906')
  assert.equal(runtime.sha256, '15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3')
  const overridden = discoverRuntime({ env: { QWENWORK_CLIENT_VERSION: '9.0.0', QWENWORK_RELEASE_VERSION: '9.0.0-test' } })
  assert.equal(overridden.version, '9.0.0')
  assert.equal(overridden.releaseVersion, '9.0.0-test')
})
test('other components retain their fallback version instead of borrowing bundled metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-runtime-'))
  const file = path.join(root, 'empty.wasm')
  fs.writeFileSync(file, Buffer.from('0061736d01000000', 'hex'))
  try {
    const runtime = discoverRuntime({ env: { QWENWORK_WASM_PATH: file } })
    assert.equal(runtime.wasmPath, file)
    assert.equal(runtime.version, '1.3.2')
    assert.equal(runtime.releaseVersion, '1.3.2-26101704')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('relocated plugin loads its bundled component without local config or environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-relocated-'))
  try {
    fs.mkdirSync(path.join(root, 'lib'))
    for (const name of ['runtime-config.mjs', 'runtime.mjs', 'constants.mjs']) {
      fs.copyFileSync(new URL(`../lib/${name}`, import.meta.url), path.join(root, 'lib', name))
    }
    fs.cpSync(new URL('../.qwenwork-runtime/', import.meta.url), path.join(root, '.qwenwork-runtime'), { recursive: true })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('QWENWORK_')))
    const moduleUrl = pathToFileURL(path.join(root, 'lib/runtime-config.mjs')).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { getRuntime } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(getRuntime()))`], { cwd: os.tmpdir(), env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const runtime = JSON.parse(result.stdout)
    assert.equal(runtime.wasmPath, path.join(root, '.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm'))
    assert.equal(runtime.version, '2.1.0')
    assert.equal(runtime.releaseVersion, '2.1.0-26111906')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('unknown signing ABI is rejected before a request can be sent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qw-abi-'))
  const file = path.join(root, 'empty.wasm')
  fs.writeFileSync(file, Buffer.from('0061736d01000000', 'hex'))
  try {
    await assert.rejects(prepareQwenworkInfer({ wasmPath: file }), /必要导出/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('error normalization handles auth, nested quota and redacts bearer values', () => {
  assert.equal(upstreamError({ statusCodeValue: 200, body: { code: 'INSUFFICIENT_CREDITS', message: '积分不足' } }).status, 429)
  assert.equal(upstreamError({ error: { message: 'unauthorized' } }).status, 401)
  assert.equal(upstreamError({ choices: [{ delta: { content: 'unauthorized' } }] }), null)
  assert.doesNotMatch(redact('Bearer sensitive-value'), /sensitive-value/)
})
let runtime
try { runtime = discoverRuntime() } catch {}
test('official component signs a fake request offline', { skip: !runtime && 'No official QwenWork signing asset on this runner' }, async () => {
  const plaintext = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'offline-only' }] })
  const prepared = await prepareQwenworkInfer({ ...runtime, cosyVersion: runtime.version, uid: 'offline', name: 'Offline', email: 'offline@example.invalid', accessToken: 'fake-access', machineId: 'offline-device', body: plaintext, modelKey: 'qwork-advanced', endpoint: 'https://gateway.qwenwork.cn' })
  assert.equal(new URL(prepared.url).origin, 'https://gateway.qwenwork.cn')
  assert.equal(new URL(prepared.url).searchParams.get('Encode'), '1')
  assert.match(prepared.headers.Authorization ?? prepared.headers.authorization, /^Bearer COSY\./)
  assert.notEqual(prepared.body, plaintext)
  assert.equal(prepared.body.includes('offline-only'), false)
})
