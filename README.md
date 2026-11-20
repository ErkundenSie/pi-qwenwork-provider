# pi-qwenwork-provider

[![CI](https://github.com/ErkundenSie/pi-qwenwork-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/ErkundenSie/pi-qwenwork-provider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

为 [Pi](https://pi.dev/) 和 [Pi Web](https://github.com/agegr/pi-web) 接入千问办公模型的非官方插件。使用自己的千问办公账号在浏览器授权，无需 API Key 或 Magpie，也不会读取桌面 App 的登录凭据。

## 快速开始

### 前置要求

- Node.js 22.19 或更高版本。
- 已安装 Pi 或 Pi Web。插件基于 Pi 1.5.2 和 Pi Web 0.17.0 开发。
- 需要千问办公中国大陆版的官方签名组件。可以配置使用源码仓库中的 `.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`，也可以安装官方桌面 App 供插件自动查找；不需要启动 App 或在其中登录。仓库中的组件提取自千问办公 2.1.0，不属于本项目 MIT 许可范围。

### 安装

**Pi Web：**打开 **设置 → 插件**，选择全局安装，填入 `git:github.com/ErkundenSie/pi-qwenwork-provider`。

**Pi CLI：**在终端运行：

```sh
pi install git:github.com/ErkundenSie/pi-qwenwork-provider
```

如果使用本地源码，在 Pi Web 填入源码目录的绝对路径，或在源码根目录执行 `pi install .`。只保留一种安装来源，避免重复加载。

### 登录并选择模型

1. 在 Pi Web 打开 **设置 → 模型 → QwenWork (OAuth)**，点击登录；在终端 Pi 中使用 `/login`。
2. 打开授权链接，在浏览器完成千问办公授权，然后返回 Pi 等待登录完成。无需粘贴验证码。
3. 在新会话的模型选择器中选择一个 QwenWork 模型；在终端 Pi 中使用 `/model`。

也可以在终端查看已加载的模型：

```sh
pi --list-models qwenwork-browser
```

## 模型

首次授权时尝试读取当前账号的千问办公模型目录。之后可在 **设置 → 模型 → QwenWork (OAuth) → 刷新模型目录** 手动同步。Pi 会缓存最近一次成功的目录；请求失败时继续使用缓存，没有该次登录的缓存才使用下方的内置列表。刷新只查目录，不发送聊天请求。

### 内置兜底目录

| 显示名称 | 模型 ID |
| --- | --- |
| 千问办公 · 标准 | `qwork-auto` |
| 千问办公 · 高级 | `qwork-advanced` |
| Qwen4-Max | `qwen4-max` |
| Qwen3.8-Max | `qwen3.8-max-preview` |
| Qwen3.8-Flash | `qwen3.8-flash` |
| Ling-3.1-Flash | `ling-3.1-flash` |
| DeepSeek-V4.1-Flash | `deepseek-flash` |
| DeepSeek-V4-Pro | `deepseek-v4-pro` |
| GLM-5.3 | `glm-5.3` |
| GLM-5.3-Flash | `glm-5.3-flash` |
| Kimi-K3.1-Pro | `kimi-k3.1-pro` |
| MiniMax-M3.1-Flash | `minimax-m3.1-flash` |
| Step-5-Preview | `step-5-preview` |

**标准和高级是千问办公的服务档位，不是 Pi 的思考强度。** 想使用指定模型，直接选模型名称。当前插件只将 Pi 的思考设置转换为推理开关标记，不会切换模型，也不保证不同档位对应不同推理强度。

表格是千问办公 2.1.0 的兜底快照；在线列表以当前账号返回的已启用模型为准。标准和高级仍保留 `qwork-auto` 和 `qwork-advanced` 作为 Pi 模型 ID。目录中出现的模型不代表已实测推理；权限、能力和积分消耗以千问办公为准。Pi 不显示办公积分余额。

### 上下文与输出预算

所有模型的默认上下文窗口为 **1,000,000 tokens（1M）**，与当前千问办公目录公布的默认档位一致。若 Pi Web 中为某个模型保存过上下文窗口覆盖值，清空该栏即可使用插件默认值。目录标注的容量不代表已实测能用满。

插件优先读取千问办公模型目录的明确输出上限。目录没填时，沿用千问办公桌面版 2.1.0 的 OpenCode 托管路径所用的 **32,768 tokens**。这是单次请求预算，不保证千问办公网关实际允许生成这么多；推理与正文可能共享预算，Pi 也会按上下文剩余空间进一步降低请求预算。

## 配置

插件会自动查找常见的千问办公安装位置，包括 Windows 的版本子目录。自定义安装路径时，可在**插件根目录**将 [`.qwenwork.example.json`](./.qwenwork.example.json) 复制为 `.qwenwork.local.json`，并修改 `appPath`。

也可以在启动 Pi 或 Pi Web 前设置以下环境变量：

| 变量 | 用途 |
| --- | --- |
| `QWENWORK_APP_PATH` | 千问办公安装根目录或 `resources` 目录。 |
| `QWENWORK_WASM_PATH` | 直接指定本机官方 App 随附的 `qoder_auth_wasm_bg.wasm`。 |

环境变量优先于本地配置。`.qwenwork.local.json` 不应提交到 Git。

### 使用仓库中的签名组件

通过 Git 克隆源码后，将 `QWENWORK_WASM_PATH` 设置为仓库内 `.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm` 的绝对路径，再启动 Pi。也可以在 `.qwenwork.local.json` 中将 `appPath` 设置为仓库内 `.qwenwork-runtime` 目录的绝对路径。插件目前不会自动查找该目录；本机配置不会随 Git 推送，换机器后需重新配置。当前 npm 打包清单不包含此目录。

该组件与官方 App 中的文件一致，不包含账号凭据。仅复制组件时，未设置版本环境变量会使用代码中的默认客户端版本；如需匹配该组件的来源版本，可设置 `QWENWORK_CLIENT_VERSION=2.1.0` 和 `QWENWORK_RELEASE_VERSION=2.1.0-26111906`。可用 `npm run doctor` 离线检查签名。

## 升级与排查

- **曾用旧目录安装：**移除旧路径的全局插件登记，只保留新路径或 GitHub 安装。供应商 ID 仍是 `qwenwork-browser`，改名不需要重新授权。
- **找不到供应商或模型列表未更新：**确认插件是全局安装，执行 `/reload` 后重新打开模型面板，再点击 **刷新模型目录**。如果仍显示旧列表，等当前任务结束后重启 Pi Web。
- **找不到签名组件：**检查 App 是否安装在运行 Pi 的同一台机器上；自定义目录按上文配置。在源码目录运行 `npm run doctor` 检查组件。
- **DeepSeek-V4.1-Flash 到达输出上限但没有正文或工具调用：**通常是思考用尽了单次输出预算，不是上下文已满。插件在该模型有文件工具时提示它先做一个最小的可运行版本；若仍失败，在用户消息里指定第一个小步骤（例如「先直接写一个精简版，再完善」），或切换到另一个模型。插件不会自动重试或换模型。Pi Web 的压缩按钮报循环 JSON 错误时，可用 `/compact` 绕过该前端错误，但压缩不会提高输出上限。
- **授权已失效：**在模型面板为 **QwenWork (OAuth)** 重新登录，不要手动配置 API Key。

## 隐私与兼容性

- 插件不主动把 Pi 会话同步到千问办公的聊天列表。发送给模型的提示词、上下文、工具结果和图片仍由千问办公服务端处理；使用组织账号前，请确认组织的审计和数据处理政策。
- 授权凭据由 Pi 保存在自己的 `auth.json` 中。不要分享该文件。要退出授权，可通过 Pi Web 模型面板断开连接，或在终端 Pi 执行 `/logout`。
- 源码仓库包含一份官方 WASM 签名组件，不包含完整千问办公 App 或账号凭据；组件来源和许可边界见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。插件不关闭 TLS 校验，也不启动本地代理端口。不支持海外站或企业 VPC；官方客户端或服务接口升级可能影响兼容性。

## 开发与测试

在源码根目录运行：

```sh
npm test
npm run doctor
```

`npm test` 使用模拟上游。将 `PI_QWENWORK_SDK_ROOT` 指向包含 `node_modules/@earendil-works/pi-ai` 的目录（例如 Pi Web 安装根目录）可启用 Pi SDK 集成测试；未找到测试依赖时对应测试会跳过。`npm run doctor` 使用本机签名组件离线检查，不登录、不发请求、不扣积分。

参见[贡献指南](./CONTRIBUTING.md)、[更新记录](./CHANGELOG.md)和[安全问题报告](./SECURITY.md)。

## 许可证

本项目采用 [MIT 许可证](./LICENSE)，基于 [qwenwork-magpie v0.1.0](https://github.com/tianyn1990/qwenwork-magpie/tree/v0.1.0) 的协议适配代码开发。上游与第三方版权信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。千问办公官方组件不在本项目的许可范围内。
