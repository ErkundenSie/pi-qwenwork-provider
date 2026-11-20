import { GATEWAY } from '../lib/constants.mjs'
import { getRuntime } from '../lib/runtime-config.mjs'
import { prepareQwenworkInfer } from '../lib/wasm.mjs'

try {
  const runtime = getRuntime()
  const body = JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Pi offline diagnostic' }] })
  const request = await prepareQwenworkInfer({
    ...runtime, cosyVersion: runtime.version, accessToken: 'offline-fake-token',
    uid: 'offline', machineId: 'offline-device', body, modelKey: 'qwork-auto', endpoint: GATEWAY,
  })
  if (new URL(request.url).origin !== GATEWAY ||
      !/^Bearer COSY\./.test(request.headers.Authorization ?? request.headers.authorization ?? '') ||
      !request.body || request.body === body) {
    throw new Error('签名组件未生成预期的推理请求。')
  }
  console.log(`千问办公 ${runtime.version}（${runtime.releaseVersion}）`)
  console.log(runtime.wasmPath)
  console.log(`SHA-256 ${runtime.sha256}`)
  console.log('离线签名通过。未访问网络、未读取账号凭据。')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
