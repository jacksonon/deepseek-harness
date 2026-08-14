# DeepSeek Harness 桌面版（完全独立的 Electron 应用）

[English](README.md) | 中文

这是 DeepSeek Harness Web 界面的**完全独立** Electron 桌面应用：服务端运行时
（`@deepseek-ai/dsh`）作为真实依赖随应用一起打包，用 Electron 自带的 Node
（`ELECTRON_RUN_AS_NODE`）启动。目标机器**不需要**安装 `dsh` CLI、**不需要**
Node —— 装好应用打开即用：它自己拉起一个私有服务（端口由系统分配，绝不会与
已在运行的 `dsh web` 冲突），在锁定加固的 `BrowserWindow` 中打开界面；
关闭窗口时随之一并结束服务进程。

本目录刻意**不**加入 pnpm workspace：它是完全独立的 npm 包，不会影响仓库中
其他进行中的改造（否则 workspace 严格的 `allowBuilds` 门槛会要求改动
`pnpm-workspace.yaml`）。

## 环境要求

- 除应用本身外无需任何东西。与模型服务商通信需要联网和 API Key —— 可在
  界面设置（Settings → Models）中填写，或沿用 dsh 的常规配置方式
  （环境变量 / `DSH_HOME`）。

## 快速开始（在源码目录）

```sh
cd desktop
npm install
npm start
```

窗口中呈现的与浏览器里 `dsh web` 的界面完全一致（包括
`window.__DSH_BOOT__` 注入与 /api 传输），因为内置的就是真正的服务端。

## 环境变量（仅开发/测试用）

| 变量                     | 含义                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `DSH_DESKTOP_DASH`       | 改用该可执行文件启动服务（例如仓库源码里的 CLI），覆盖内置服务端。     |
| `DSH_DESKTOP_EXTRA_ARGS` | 传给 `dsh web` 的额外参数（空格分隔），例如 `--trusted-host app.internal:3080`。 |
| `DSH_DESKTOP_SMOKE`      | `1` = 自检模式：启动→加载→打印 `DSH_DESKTOP_SMOKE_OK <url>`→退出 0（失败退出 1）。 |

## 打包分发

```sh
npm run dist            # dmg + zip (macOS arm64+x64), nsis (Windows x64), AppImage (Linux)
npm run dist:dir        # unpacked app only, for a quick check
```

产物位于 `desktop/dist/`。打包后的应用完全独立 —— `dsh` 服务端运行时就在
应用内部。`asar` 已关闭，内置服务端及其原生模块以真实文件随包发布。

`dependencies` 中刻意列出了内置运行时引用的每一个 `@deepseek-ai` 插件，
包括 harness 各包只声明为 `peerDependencies` 的插件（例如
`@deepseek-ai/cordis-plugin-group`）：electron-builder 的 npm 收集器只打包
应用自身的依赖树、会丢弃纯 peer 依赖，因此只作为 peer 存在的插件在源码
目录里能正常启动，到了干净的机器上就会以 `ERR_MODULE_NOT_FOUND` 崩溃。
凡是内置服务端运行期需要的插件，都应显式加到这里。

## 工作原理

1. 主进程解析内置 CLI 入口（`node_modules/@deepseek-ai/dsh/lib/bin.js`）。
2. 以 `ELECTRON_RUN_AS_NODE=1` 启动 `process.execPath`，并带上
   `--expose-internals`（harness 的 HMR 插件需要；Electron 禁止在
   `NODE_OPTIONS` 中传该参数，但作为命令行 node 参数是允许的），
   传入 `web --port 0`，解析就绪行 `dsh web: http://127.0.0.1:<port>`。
3. 打开 1280×840 窗口（context isolation、禁用 node integration、
   渲染进程沙箱化），加载服务地址，并拦截一切跨源跳转。
4. 外部 `http(s)` 链接交给系统浏览器打开。
5. 关闭窗口（或收到 SIGINT/SIGTERM）时向服务进程发送 SIGTERM 并退出。
   会话中服务进程意外退出则弹出错误提示并关闭应用。

## CI 发布

`.github/workflows/desktop-release.yml` 在原生 runner 上构建并发布 macOS /
Windows 应用，对打包产物做就地冒烟验证，并上传到推送的 `v*` 标签对应的
GitHub Release。签名/公证所需的 secrets 与手动触发方式见工作流文件头部注释。
该工作流中为 TUI CLI 的发布预留了位置。
