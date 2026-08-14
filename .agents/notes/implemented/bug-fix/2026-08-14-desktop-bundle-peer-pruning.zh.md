# Agent Note: 桌面应用未打包其内置服务端所引用的纯 peer 插件

Status: implemented

[English](2026-08-14-desktop-bundle-peer-pruning.md) | 中文

## 问题

v0.1.0 桌面应用在干净的机器上启动即崩溃，报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis-plugin-group'`：内置的 `dsh` 服务端在打印就绪行之前就退出了——官方 Windows 安装包和 mac 构建无一幸免。打包后的 `node_modules` 缺少 `cordis-plugin-group` 以及另外 18 个 `@deepseek-ai` 包，尽管在开发环境和 CI 中所有被引用的插件都能解析。

两个原因叠加：

1. **electron-builder 只打包应用自身 `dependencies` 树，纯 peer 依赖会被丢弃。** harness 各包把插件接缝声明为 `peerDependencies`（`dsh-app-boot` → `cordis-plugin-group`、`dsh-commands` → `dsh-scope` 等）。`npm ci` 会把这些 peer 自动装进桌面应用的 `node_modules`，但 electron-builder 的 npm 收集器会剪掉一切无法通过 `dependencies` 字段触达的包，于是所有运行期被 import 的 peer 都没有进入安装包。
2. **CI 冒烟测试在仓库检出目录内运行打包应用，掩盖了缺失。** Node 解析内置服务端的 import 时从应用包向上逐层查找 `node_modules`；从 `desktop/dist/...` 启动时，查找会一路落到检出目录的 `desktop/node_modules`，而那里恰好有这些 peer。mac 与 Windows 的冒烟测试双双通过。只有干净的机器——或者把同一应用复制到仓库之外运行——才能复现崩溃。

## 决策

- `desktop/package.json` 把内置运行时引用的每个 `@deepseek-ai` 包都声明为直接 `dependencies`：`@deepseek-ai/cordis-plugin-group` 加上静态 import 分析与仓库外启动共同找出的其余 18 个纯 peer 包（`dsh-anonymous-user-id`、`dsh-atomic-write`、`dsh-bash-local`、`dsh-code-runtime`、`dsh-compaction`、`dsh-fs`、`dsh-invariants`、`dsh-output-retention`、`dsh-sandbox`、`dsh-scope`、`dsh-session-telemetry`、`dsh-session-title-llm`、`dsh-shell`、`dsh-spill`、`dsh-subagent-in-process-driver`、`dsh-subprocess`、`dsh-timeout`、`dsh-workflow`）。这是 peer 契约的叶子消费方一侧：harness 各包继续把 peer 当 peer，而无法依赖任何环境安装的独立应用钉住自己需要的那些。
- 发布工作流中的两个冒烟步骤（mac 与 Windows）都把打包应用复制到 `$RUNNER_TEMP` 再运行，启动过程不再可能落到检出目录的 `node_modules`。

## 备选方案

**把各 harness 包内的 peer 提升为 `dependencies`。** 对打包型消费者是正确的，但要为一个叶子应用改动每个包的发布清单；且仓库的 peer 约定正是为了让多个消费者共享同一个 cordis 实例。为了桌面修复而做，超出范围，否决。

**把缺失的包加进 desktop 的 `devDependencies` 并关闭裁剪。** devDependencies 本就不会被打包，electron-builder 的 npm 收集器也没有保留应用自身树中纯 peer 包的开关。不可行。

**保留仓库内冒烟，另外对打包后的 `node_modules` 做静态完整性检查。** 静态检查确实能抓住这个 bug，但仓库外冒烟以更少的机制端到端覆盖了同样的范围（ESM import、加载期的 `name:` 解析、原生模块加载）。冒烟即门槛。

## 影响

打包应用因此增加 19 个小插件包（几 MB）。今后内置运行时若开始引用新的纯 peer 插件，必须同步加入 `desktop/package.json`：README 记录了这条规则，仓库外冒烟会在发布时拦住遗漏。检出目录内的 `npm run smoke` 仍会从开发 `node_modules` 解析到 peer，无法校验安装包——只有从干净路径运行打包应用才能校验。

## 测试

- 复现用户崩溃：v0.1.0 打包 mac 应用从 `/tmp` 运行即报 `@deepseek-ai/cordis-plugin-group` 的 `ERR_MODULE_NOT_FOUND`（官方 Windows 安装包表现相同——其归档中 `cordis-plugin-group` 文件数为零）。
- 修复后：重新构建的应用从 `/tmp` 运行成功启动服务端、加载 GUI 并打印 `DSH_DESKTOP_SMOKE_OK`（退出码 0）；仓库内冒烟保持绿色。
- 完整引用集（打包内 `dsh-base`/`dsh-web-app` 补丁层与各 agent preset 的全部 134 个 `name:` 条目）在打包后的 `node_modules` 中全部存在。
