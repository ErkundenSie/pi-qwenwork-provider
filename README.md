# pi-qwenwork-provider

把**千问办公**接入 [Pi](https://pi.dev/) 和 [Pi Web](https://github.com/agegr/pi-web)。插件通过浏览器独立授权，使用你自己的账号与办公积分。**不需要 Magpie 或 API Key，不读取或写回千问办公桌面 App 的登录凭据。**

## 安装与使用

前提：Node.js 22.19+、Pi 或 Pi Web，以及本机安装的千问办公中国大陆版桌面 App。App 不必保持运行，但需要它随附的静态签名组件。本项目按 Pi **1.5.2**、Pi Web **0.17.0** 和千问办公 **2.1.0** 的环境开发。

1. 在 Pi Web 的**插件**页面选择全局安装，粘贴 `git:github.com/ErkundenSie/pi-qwenwork-provider`。也可在终端运行：
   ```sh
   pi install git:github.com/ErkundenSie/pi-qwenwork-provider
   ```
   如需使用本地源码，填入源码目录的绝对路径，或在源码目录运行 `pi install .`。
2. 打开 Pi Web 的**模型**面板，找到 **千问办公（浏览器授权）**，点击登录。打开授权链接确认，回到 Pi Web 等待完成，无需粘贴验证码。终端 Pi 可用 `/login`。
3. 在新会话的模型选择器里选一个千问办公模型，发一句短消息测试。终端 Pi 用 `/model` 选择。

从旧版升级时，请移除旧路径的全局插件登记，只保留一种安装来源，随后执行 `/reload`。**包名虽然改了，内部供应商 ID 仍是 `qwenwork-browser`**，不需要重新授权。若旧列表仍在，等任务结束后再重启 Pi Web。

## 模型目录

标准和高级是千问办公的服务档位，不是 Pi 的思考强度。想固定具体模型，就直接选指定模型。Pi 的思考档位目前只用于生成是否开启推理的标记，不会切换模型，也不保证各档对应不同推理强度。

| 模型 | Pi 模型 ID |
| --- | --- |
| 标准 / 高级 | `qwork-auto` / `qwork-advanced` |
| Qwen4-Max | `qwen4-max` |
| Qwen3.8-Max | `qwen3.8-max-preview` |
| Qwen3.8-Flash | `qwen3.8-flash` |
| Ling-3.1-Flash | `ling-3.1-flash` |
| DeepSeek-V4.1-Flash | `deepseek-flash` |
| DeepSeek-V4-Pro | `deepseek-v4-pro` |
| GLM-5.3 / GLM-5.3-Flash | `glm-5.3` / `glm-5.3-flash` |
| Kimi-K3.1-Pro | `kimi-k3.1-pro` |
| MiniMax-M3.1-Flash | `minimax-m3.1-flash` |
| Step-5-Preview | `step-5-preview` |

这是千问办公 2.1.0 的目录快照，不会随套餐或上游自动更新。列出不代表每个模型都验证过实际推理；权限、实际消耗与兼容性以上游为准。部分模型不支持图片。Pi 不显示办公积分余额。

## 非标准安装路径

插件会查找常见的 App 安装位置，包括 Windows 的版本子目录。找不到时，把 [`.qwenwork.example.json`](./.qwenwork.example.json) 复制为 `.qwenwork.local.json`，将 `appPath` 改为本机千问办公安装根目录。不要提交本地配置文件。

也可在启动 Pi 或 Pi Web **之前**设置 `QWENWORK_APP_PATH`（App 根目录或 resources 目录）或 `QWENWORK_WASM_PATH`（签名文件路径）。环境变量优先于本地配置。

## 隐私与已知限制

- 插件不主动把 Pi 会话同步到千问办公界面。发送给模型的提示词、上下文、工具结果和图片仍由千问办公服务端处理。使用组织账号时，请先确认组织策略和审计范围。
- 授权由 Pi 保存在自己的 `auth.json`。不要分享该文件；退出授权请用 Pi Web 模型面板或终端 `/logout`。
- 这是非官方适配，不支持海外站和企业 VPC。App 或服务端协议更新后可能需要修改插件。项目不分发官方 App 或 WASM、不关闭 TLS 校验、不启动代理端口。

## 开发与测试

```sh
npm test
npm run doctor
```

`npm test` 使用模拟网络；`npm run doctor` 用本机官方组件做离线自检，不登录、不发请求、不扣积分。要运行 Pi SDK 集成测试，将 `PI_QWENWORK_SDK_ROOT` 指向包含 `node_modules/@earendil-works/pi-ai` 的 Pi Web 安装目录或测试用依赖目录。未配置 SDK 或签名组件时，对应测试会跳过。

见 [更新记录](./CHANGELOG.md)、[贡献指南](./CONTRIBUTING.md) 与 [安全报告指南](./SECURITY.md)。

## 许可与致谢

代码采用 [MIT 许可证](./LICENSE)。本插件基于 [tianyn1990/qwenwork-magpie v0.1.0](https://github.com/tianyn1990/qwenwork-magpie/tree/v0.1.0) 的协议适配代码开发，上游与第三方版权说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。千问办公官方组件不在本项目许可范围内。
