# dsh-self 参考项目与文档

核对日期为 2026-11-22。对应[专属客户端生成器实施方案](implementation-plan.md)。下文列出源码位置、查到的底层行为、实码纠偏依据和可直接复用的机制。社区候选与上游仓库均采用固定提交或标签链接，便于后续复查。

<a id="octo"></a>

## 1. OctoDeEpSeeK 本地基线

本地仓库为 `C:\WorkSpace\OctoDEepSeeK`，本地 origin 指向 GitHub 项目 `Octo-o-o-o/OctoDeepSeek`。核对时 `main` 与本地 `origin/main` 均为 `48f3f01961d34509bc85245dadc6dfdaede9b65b`。下列相对链接按两个工程同处 `C:\WorkSpace` 的布局编写。以后工作树有变动，可用文末命令查看当时的提交内容。

| 参考材料 | 方案中用到的事实与用途 |
|---|---|
| [项目 README](../../OctoDEepSeeK/README.md)、[可行性与方案设计](../../OctoDEepSeeK/docs/feasibility-and-design.md)、[原实施计划和验收记录](../../OctoDEepSeeK/docs/implementation-plan.md) | 查阅已建设的外壳、固定办公组合、数据策略、打包裁剪和各阶段验证。原项目的千手视觉参考来自 OctoDesk，上述可行性文档 §3.2、§6 说明了借鉴范围。 |
| [项目约定](../../OctoDEepSeeK/AGENTS.md)、[根包工具与命令](../../OctoDEepSeeK/package.json)、[桌面包版本](../../OctoDEepSeeK/apps/desktop/package.json)、[运行时清单](../../OctoDEepSeeK/apps/desktop/runtime/package.json)、[运行时依赖锁](../../OctoDEepSeeK/apps/desktop/runtime/package-lock.json) | 版本基线为 Node 26.12.1、pnpm 11.28.5、dsh 0.2.2-rc.5、Cordis 4.1.0、Electron 44.11.5、electron-builder 26.18.0（内置纯 JS `resedit@1.7.2`）。沿用独立测试目录、先构建后测试、React 18 与双语客户端约定。 |
| [办公插件准备脚本](../../OctoDEepSeeK/scripts/qianshou-preview.mjs)、[连接插件版本](../../OctoDEepSeeK/packages/dsh-shell-octo/src/connection-plugins.ts) | 锁定八项预览插件；脚本第 11 行记录了 `@chaiyahang/dsh-scratchpad` 高版本抢占默认搜索快捷键的冲突实例，是目录登记快捷键互斥表的直接依据。此前手工补软链与 `entry.ts` 钩子系测试将 `<profile>/node_modules` 软链出 `profiles/` 目录绕过了 dsh 原生拦截器所致；生成版使用 `<userData>/h/profiles/p-<hash>` 真实目录即可直接走原生共享解析。 |
| [首页及业务入口注册](../../OctoDEepSeeK/packages/dsh-shell-octo/src/client.tsx)、[首页组件](../../OctoDEepSeeK/packages/dsh-shell-octo/src/HomePanel.tsx)、[主题入口](../../OctoDEepSeeK/packages/dsh-theme-octo/src/client.ts)、[主题变量](../../OctoDEepSeeK/packages/dsh-theme-octo/src/tokens.ts) | 工作应用面板表、侧栏项与 110+ 项 `--dsw-*` 变量目前在源码静态声明；`client.tsx` 在目标面板未挂载时静默忽略点击。生成版改为读 `product.json` 的 8 项亮暗语义种子色统一派生主题与窗口底色，并修复未启用核心面板的一键恢复提示。 |
| [标准 bundle 清单](../../OctoDEepSeeK/tests/fixtures/sample-plugin/package.json)、[示例 bundle 补丁](../../OctoDEepSeeK/tests/fixtures/sample-plugin/cordis.patch.yml)、[客户端构建器](../../OctoDEepSeeK/tools/dsh-client-build/src/build.ts)、[客户端模块包装器](../../OctoDEepSeeK/tools/dsh-client-build/src/wrap.ts)、[运行时叠加层](../../OctoDEepSeeK/packages/octo-overlay/src/overlay.ts) | `wrap.ts` 当前仅写死 11 个 `PLATFORM_MODULES` 且 `build.ts` 采用 esbuild `format: 'cjs'` 单文件输出（esbuild CJS 模式不支持 `splitting: true`）。扩展构建器须同步校验 `package.json#dsh.client.external` 预加载声明，并将每个 `src/client.<name>.ts(x)` 分别打包为自包含且带 `chunk` 字段的 `lib/client.<name>.js`，供入口通过显式 `require.async("./client.<name>.js")` 按需加载。 |

**固定办公组合。** 可把现有预览组合用作首批目录的输入，每项仍需按目标系统和具体业务动作登记证据。前四项由准备脚本锁定，后四项来自连接插件表。

| 已锁定来源 | 已锁定来源 |
|---|---|
| [Better Sidebar 0.32.1](https://registry.npmjs.org/dsh-better-sidebar/0.32.1) | [Office Preview 0.2.0](https://registry.npmjs.org/@huanlin/dsh-plugin-better-sidebar-plugin-office/0.2.0) |
| [Scratchpad 0.2.5](https://registry.npmjs.org/@chaiyahang/dsh-scratchpad/0.2.5) | [Kanban 1.13.1](https://registry.npmjs.org/@alpacachen/dsh-kanban/1.13.1) |
| [Email 0.31.0](https://registry.npmjs.org/dsh-email/0.31.0) | [Calendar 0.20.5](https://registry.npmjs.org/dsh-calendar/0.20.5) |
| [IM Connect 1.0.49](https://registry.npmjs.org/@michengai/dsh-im-connect/1.0.49) | [MCP OAuth Bridge 0.1.1](https://registry.npmjs.org/@f12o/mcp-oauth-bridge/0.1.1) |

<a id="desktop"></a>

### 桌面身份、隔离与构建

| 源码或文档 | 方案设计依据 |
|---|---|
| [产品身份](../../OctoDEepSeeK/apps/desktop/src/identity.ts)、[主进程](../../OctoDEepSeeK/apps/desktop/src/main.ts)、[窗口守卫](../../OctoDEepSeeK/apps/desktop/src/window-guards.ts)、[导航守卫](../../OctoDEepSeeK/apps/desktop/src/host/navigation.ts)、[构建器配置](../../OctoDEepSeeK/apps/desktop/electron-builder.yml)、[原生加载页](../../OctoDEepSeeK/apps/desktop/loading.html)、[品牌组件](../../OctoDEepSeeK/packages/dsh-shell-octo/src/BrandMark.tsx) | `identity.ts` 当前为编译期常量且 `applyPackagedDebugLock` 无法拦截早期 V8 参数，需以 Electron Fuses 替代；`main.ts` 含 `isolated/shared` 双空间且未挂 `setPermissionRequestHandler` 默认拒绝。生成版保持 `app.asar` 不可变硬链接，运行时统一从 `resources/product/identity.json` 读身份/版本/品牌并在单实例锁前设置 `userData`/`sessionData`/`crashDumps`。`navigation.ts:57-60` 已允许子帧加载 `about:srcdoc`，支撑 `docx-preview` 沙箱化。 |
| [数据空间](../../OctoDEepSeeK/apps/desktop/src/host/data-space.ts)、[建档逻辑](../../OctoDEepSeeK/apps/desktop/src/host/profile.ts)、[端口选择](../../OctoDEepSeeK/apps/desktop/src/host/port.ts)、[默认工作区补丁](../../OctoDEepSeeK/apps/desktop/src/host/workspace-documents.ts)、[Host 启动](../../OctoDEepSeeK/apps/desktop/src/host/launch.ts)、[Host 入口](../../OctoDEepSeeK/apps/desktop/src/host/entry.ts)、[日志脱敏](../../OctoDEepSeeK/apps/desktop/src/host/redact.ts) | `port.ts` 单次占用即永久覆写端口会改写 Origin 清空存储，需改首选/回退端口池；`launch.ts:153-156` 直接透传 `...process.env`（存在 `NODE_OPTIONS`/`DEEPSEEK_API_KEY`/`DSH_*` 注入与凭据泄漏），须改最小环境变量白名单（保留 OS 基础项、企业代理与 `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`）；`entry.ts` 调用 `runProfile` 须显式传 `loadLayeredEnv('dsh', dshHome)` 并按 `host-pids.json` 回收崩溃残留进程；`redact.ts` 仅覆 2 条正则，需扩充覆盖主流密钥、JWT、PEM 私钥与用户名路径。 |
| [运行时路径](../../OctoDEepSeeK/apps/desktop/src/host/runtime-paths.ts)、[装配器](../../OctoDEepSeeK/scripts/assemble-runtime.mjs)、[打包后处理](../../OctoDEepSeeK/apps/desktop/after-pack.cjs)、[Windows 构建入口](../../OctoDEepSeeK/scripts/package-win.mjs) | `after-pack.cjs` 写死 `octodeepseek` 与 `linux-x64` 路径，且 **`electron-builder --prepackaged` 会完全跳过 `afterPack`**。生成版改为只读 `base-shell` + `%LOCALAPPDATA%` 同卷硬链接暂存 + Staging 阶段自行执行纯 JS `resedit`/权限/重签 + 单文件 `profile-seed.tar.gz`，最后仅由 `--prepackaged` 封安装器。 |
| [Linux 构建](../../OctoDEepSeeK/scripts/package-linux.mjs)、[macOS 构建](../../OctoDEepSeeK/scripts/package-mac.mjs)、[macOS 验收报告](../../OctoDEepSeeK/docs/macos-handoff.md)、[README 打包章节](../../OctoDEepSeeK/README.md#打包) | Windows NSIS x64、Linux AppImage/deb x64、macOS arm64/x64 DMG 均有基线。实查 `app-builder-lib@26.18.0` 发现 Linux `.deb` 的 `/opt/${sanitizedProductName}` 与 `desktopName` 写死会导致跨产品碰撞，Ubuntu 24.04 AppImage 会因 `apparmor_restrict_unprivileged_userns=1` 静默降级 `--no-sandbox`；macOS `--prepackaged` 跳过 `codesign` 且直接收 `.app` 路径，须在 Staging 完成主包与 4 Helper 改名及由内向外 ad-hoc 重签。 |
| [Office 探针](../../OctoDEepSeeK/scripts/probe-office.mjs)、[插件端到端测试](../../OctoDEepSeeK/tests/e2e/phase-2.spec.ts)、[第三方声明](../../OctoDEepSeeK/THIRD_PARTY_NOTICES.md) | 裁掉 `@deepseek-ai/libreoffice-kit*` 后改由按需加载的纯前端 `docx-preview`（隔离在 opaque-origin `<iframe sandbox="allow-scripts">` 内）替代；`apps/desktop/runtime` 内置 `sharp@0.35.5`（基于 libvips/librsvg/Cairo），因 Cairo 存在 `32,767 px` 单轴硬上限，超长图导出改为逐标注小块 SVG 经 `sharp.composite` 合成。 |

<a id="tests"></a>

### 从哪些测试开始改

| 参考入口 | 可移植的验证 |
|---|---|
| [会前准备业务逻辑](../../OctoDEepSeeK/packages/dsh-shell-octo/src/meeting-prep.ts)、[工作流端到端](../../OctoDEepSeeK/tests/workflows/workbench.spec.ts) | 日历、邮箱 fixture 与真实文件操作结合，验证来源、失败重试与重启恢复。`workbench.spec.ts` 第 60–67 行也记录了新 `DSH_HOME` 首启必弹「预览版说明」与「开始使用」对话框的现象，生成版改为配置级静默并断言首屏无遮挡。 |
| [插件安装及 Host 恢复测试](../../OctoDEepSeeK/tests/e2e/phase-2.spec.ts)、[双空间测试](../../OctoDEepSeeK/tests/smoke/two-spaces.test.ts) | 本地插件启用、卸载与 Host 崩溃恢复。生成器淘汰双空间模型，改为不同 `productId` 客户端同机同时运行的身份、端口、Cookie 与工作区隔离测试。 |
| [打包应用冒烟](../../OctoDEepSeeK/scripts/packaged-smoke.mjs)、[安装与卸载](../../OctoDEepSeeK/scripts/test-installed.mjs)、[测试目录约束](../../OctoDEepSeeK/scripts/smoke-guard.mjs) | `test-installed.mjs` 原按 `DisplayName -eq 'OctoDeEpSeeK'` 和固定文件名查找。生成版改为按显式 `nsisGuid` 查询 `HKCU:\...\Uninstall\<guid>`，新增改展示名覆盖升级清理旧 `.lnk`、同名不同 GUID 后缀消歧与 `$launchLink` 校验、`seedHash` 换槽/回滚、安装期与运行期防降级、`LongPathsEnabled=0` 及人工注入 MoTW 断言。 |

已存在的命令有 `build`、`typecheck`、`test`、`test:smoke`、`test:e2e`、`test:workflows`、`package:win`、`test:packaged`、`test:installed`，均以项目指定的 `npx --yes pnpm@11.28.5` 执行。跨平台工作区与环境边界见[本机工作区约定](../../AGENTS.md)。鉴于宿主固定为 RC 版本，须在 `tests/` 设立集中式 `upstream-contract.test.ts` 契约守卫，锁定 `PLATFORM_MODULES`、`WELCOME_NOTICE_VERSION`、`presets` 结构、`session-log-deepseek` 开关与 `client-modules` wire 格式。

<a id="dsh"></a>

## 2. DeepSeek Harness 官方接口

官方仓库为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，本地只读检出为 `C:\WorkSpace\Reference\deepseek-harness`（工作树分支可能领先，一律以固定标签为准）。接口统一核对标签 `dsh-v0.2.2-rc.5`，其提交为 `9c2670d3bce5275e0d1610272958121af87787bb`。产品层创造模式的官方说明见 [DeepSeek Harness 产品页](https://www.deepseek.com/zh/harness/)。

| 上游文档或源码 | 使用方式与核实结论 |
|---|---|
| [插件索引格式与发现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/plugin-market.zh.md)、[索引服务与 plugin_market](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-market/README.zh.md)、[官方索引生成器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/apps/plugin-market-generator/README.zh.md) | 公开索引提供包源与版本；业务动作映射、三级信任分层、六维冲突表（`entryIds`、`httpRoutes`、`panelIds`、`exclusiveSlots`、快捷键、服务名）与场景组合排序由 `dsh-self` 受控白名单目录维护。 |
| [当前 profile 插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/README.zh.md)、[插件管理工具](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/plugin-manager/src/tools.ts)、[只读插件清单](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/plugin-inventory/src/index.ts)、[宿主兼容性函数](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/plugin-compatibility.ts)、[Profile 运行时模块解析](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/profile-resolution/resolver.ts) | `resolver.ts` 已对 `<DSH_HOME>/profiles/*` 内置完整的 ESM/CJS/`#imports`/`worker_threads` 共享包拦截（前提是真实目录位于 `profiles/` 下且清扫 `<seed>/node_modules` 中的 `@deepseek-ai/dsh*` 与 `@deepseek-ai/cordis*` 影子副本）。`evaluatePluginCompatibility` 对无声明包与声明匹配包均返回 `undefined`，且存在 `engines.dsh` 时跳过全部 `peerDependencies`，选型器须前置区分并补查 `cordis`/`react` peer 与平台/Node 约束。Web 模式下顶层 `tool-plugin-manager` 早已被禁用，实际生效行嵌套在 `presets/{standard,ptc,cordis}.patch.yml`（L132/133/135），因此预览 `--patch` 必须直接禁用 `id: plugin-manager`、`id: ui-plugin-manager` 与 `id: hmr`（`plugin-inventory` 在无 `pluginManager` 时自动降级只读）。 |
| [WebServer 路由匹配](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/webserver/src/index.ts)、[连接鉴权与 Fetch 路由](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/rpc-host.ts)、[浏览器信任栅栏](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/src/api-request-trust.ts)、[鉴权路由示例](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/host/open-in-app/src/index.ts) | **`webServer.match()`（L365–373）按精确/最长前缀优先且不做鉴权**；若薄适配器或 `/api/product-spec` 直接调用 `ctx.webServer.register('/api/...')` 会绕过 `client-connection` 挂在 `/api` 的鉴权与 Origin 栅栏。正确做法是走 Typert Remote 或 `ctx.connection.fetch.register(route)`（特殊流式路由须首行调 `ctx.connection.requestRejection(req)`）。同时 `api-request-trust.ts` 硬拒 `Origin: null` 与 `sec-fetch-site: cross-site`，与 `docx-preview` opaque iframe 形成双重封锁；因 Cookie 按 Host（`127.0.0.1`）而非端口隔离，预览窗口必须使用独立 Electron Session 分区防跨端口窃取 Studio `dsh-auth-*` Cookie。 |
| [工作区默认目录](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/workspace-controller/src/default-directory.ts)、[工作区注册服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/workspace/workspace/src/index.ts) | `default-directory.ts` 默认在文稿目录追加 `deepseek-harness/default-workspace`；由壳插件 Host 端在首启为空时调用公开方法 `ctx.workspaceRegistry.create(dir, displayName)` 注册 `<用户主目录>/Workspaces/<internalSlug>`，即可幂等跳过默认拼接且避免直接改写内部状态机。 |
| [基础 Bundle 补丁](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/base/cordis.patch.yml)、[Web 应用 Bundle 补丁](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/bundle/web-app/cordis.patch.yml)、[配置编辑器边界](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/config-editor/src/index.ts)、[会话日志上报说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/session/session-log-deepseek/README.zh.md)、[本地凭据存储](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/credentials/credentials-local/src/index.ts)、[模型引导配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-settings-models/src/index.ts)、[欢迎提示版本](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-settings-models/src/onboarding-copy.ts)、[设置启动插槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-settings-general/src/client/SettingsRoot.tsx) | `profileContext.name !== 'desktop'` 实际关闭 `desktop-product-telemetry`、`product-analytics`、`workspace-dependencies`、`ui-sidebar-browser`，并将 `skill-office.pythonEnvironment` 退回 `'user'`、`deepseek-account.desktopPlatform` 置 `null`（共 6 处）。**关键隐私实证**：`base/cordis.patch.yml` 第 43/85 行默认启用 `session-log-deepseek`（独立于 OTel，`DSH_TELEMETRY_DISABLED=1` 关不掉）与 `plugin-package-inventory-deepseek`；且 `config-editor/src/index.ts:141-145` 禁止通过 UI 编辑已被 `--patch` 覆盖的条目。因此 `ui-settings-general.welcomeNoticeVersion`（`'2026-09-28.1'`）与 `session-log-deepseek.enabled: false` 必须写入**种子 `cordis.patch.yml`**（绝不写入 `--patch`），并在双槽升级时执行键级深合并。POSIX 下 `.credentials.yaml` 强制检查 `0600` 权限；接管 `settings.launcher` 插槽可拿到 `openSettings('models')`。 |
| [浏览器模块加载子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/subsystems/client-modules.zh.md)、[客户端构建参考](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/tsdown.client.ts)、[浏览器 UI 插槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-slots/README.zh.md)、[文档安全预览参考](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-sidebar-documentpreview/src/client/html/basic-document.ts)、[客户端插件管理界面](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/ui-plugin-manager/README.zh.md)、[个性化页面校验](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/experimental/creation-recommendations/src/generated-bundle.ts) | `ui-layout` 的 `selectPanel(panelId)` 仅收无参面板 ID，`ui-plugin-manager` 提供 `plugins.detail.badge` 标记核心组件，`client-modules` 原生要求各异步 chunk 自包含并以 `chunk` 字段注册供 `require.async` 加载。`basic-document.ts` 已实践 DOMPurify + 严格 CSP 隔离文档 HTML。`dsh-app-boot` 默认解析 `cordis.patch.yml` 支持可执行 `!!js` 标签；`generated-bundle.ts:24-28` 使用 `parseDocument(..., { schema: 'core', customTags: [] })` + `maxAliasCount: 0` 封禁 `!!js` 与 YAML 炸弹。须明确 Host 插件无 OS 沙箱、且原生 `dsh.client` 共享已鉴权 Host 同源亦**不构成安全沙箱**，故 M5 优先走受控 `product-spec` / opaque iframe 沙箱。 |

<a id="input"></a>

### 模型、附件、语音、防注入与渲染安全

- **多模态路由与降级**：图片能否输入由实际路由和模型声明决定，自定义模型默认 `input` 仅为 `[text]`，须显式包含 `image` 才接收设计图；制作器在发送前探测模态并提供本地提取主色加预设骨架回退。[模型与图片输入配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/user/guide/providers.zh.md)
- **附件用途与本地语音**：上传服务接收文件后由产品层显式区分「工作台参考图」与「业务待处理文件」；本地 SenseVoice 转写为默认关闭的可选 bundle，可复用其转写后进入可编辑文本框的交互。[文件上传服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/file-upload/README.zh.md) · [实验性语音输入](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/experimental/voice-input-bundle/README.zh.md)
- **CaMeL 污点分离与双层 SSRF 防护**：参考 Google DeepMind CaMeL（*Defeating Prompt Injections by Design*, 2025），无工具权限视觉提取输出拆分 `controlSafe`（闭集枚举）与 `taintedDisplay`（不可信文案，不回流规划 LLM）；抓取参考网址因 HTTPS `CONNECT` 隧道内密文不可见且企业上游代理独立解析 DNS，须组合「临时受控代理（随机 `Proxy-Authorization`、端口与全量 IPv4/IPv6 私网拦截、直连 IP 固定）+ Electron 非持久化会话层（`proxyBypassRules: '<-loopback>'`、`webRequest.onBeforeRequest`/`onBeforeRedirect`、禁 ServiceWorker、取消下载、禁非代理 UDP）」。[Electron Session 代理与分区文档](https://github.com/electron/electron/blob/v44.11.5/docs/api/session.md) · [Electron 安全基线](https://github.com/electron/electron/blob/v44.11.5/docs/tutorial/security.md)
- **OOXML / `docx-preview` 与 `sharp`/Cairo 安全边界**：`docx-preview` 需防范 `w:altChunk` 等解析型 Stored XSS（如 CVE-2026-109290 案例）与 ZIP 炸弹/UNC 外泄，采用「Host 剥离危险结构并注入确定性书签 + 前端 `renderAltChunks: false` + DOMPurify（保留并净化 `<style>`）+ `<iframe sandbox="allow-scripts" srcdoc>`（无 `allow-same-origin` + 随机 `nonce` 极简 `postMessage` 桥）」。`sharp` 底层 `librsvg`/Cairo 存在不可由 `limitInputPixels` 绕过的 `32,767 px` 单轴硬上限，超长图导出改为逐标注小块 SVG 经 `sharp.composite` 在光栅层合成；前端画布则用限边预览代理规避 Chromium `16,384 px` GPU 纹理上限。

<a id="candidates"></a>

## 3. 社区插件与静态核对

2026-11-22 对以下四个提交的 `package.json` 运行了本机 rc.5 公共函数 `evaluatePluginCompatibility(manifest, {}, runtimeVersion)`，使用空豁免表。这一步只读取 JSON。表中「通过」指声明通过，未在本轮安装、执行业务、使用账号或发起模型请求。第三方仓库的运行记录注明为作者记录。

| 项目与版本 | 实际用途与形态 | 本次结论与接入定位 |
|---|---|---|
| **Jegozhou / dsh-plugin-bidkit 0.1.0**，提交 `ed1a727` | 招标解析、按评分项编排、资料核对、生成 Word，含纯 JS OOXML 模块与整页工作台。作者有桌面宿主及 DOCX 导出验证记录。 | 未声明 `engines.dsh` 或 dsh peer。按未声明实测流程验证 `rc.5` 冷启动及服务边界；投标首页排序、扫描件阻断与 `docx-preview` 沙箱化双向定位由模板自有 `list-detail` 及薄适配器保底，并约定共享工作区项目数据目录防双入口状态分裂。[作者说明](https://github.com/Jegozhou/dsh-plugin-bidkit/blob/ed1a727dad0bc686a38a9bf4c70d06406a1edbf0/README.md) · [包清单](https://github.com/Jegozhou/dsh-plugin-bidkit/blob/ed1a727dad0bc686a38a9bf4c70d06406a1edbf0/package.json) · [作者验证记录](https://github.com/Jegozhou/dsh-plugin-bidkit/blob/ed1a727dad0bc686a38a9bf4c70d06406a1edbf0/docs/VERIFICATION.md) |
| **duhu2000 / dsh-tender-workbench 0.5.11**，提交 `1fe5012` | 借助用户授权的企查查 MCP 查询标讯，按规则筛选、复核、导出 Excel/PDF。 | 核心 peer `~0.1.2-rc.1` 与本项目冲突，共 13 项。首版用于验证选型器识别宿主冲突和区分「查标讯」与「写标书」意图，并在缺口页引导标准 MCP 替代。[作者说明](https://github.com/duhu2000/dsh-tender-workbench/blob/1fe5012d8218dde9031332e5fb09d5d449f8a8cb/README.md) · [包清单](https://github.com/duhu2000/dsh-tender-workbench/blob/1fe5012d8218dde9031332e5fb09d5d449f8a8cb/package.json) |
| **OrderG-X / dsh-design-studio 0.28.0**，提交 `49a42f0` | 面向 AI 生成 HTML/UI 原型的多页面设备画框工作台、风格提取与版本对照（社区存在同名仓库，目录按完整仓库路径+SHA 唯一标识）。 | dsh peer 声明通过。因其为整页编译面板、不可拆作可重排的位图批注三栏首页，方案中由模板自有 `three-pane` 面板与内置 `sharp` 承载位图批注和确定性导出，本包作为可选配套原型面板实测共存。[作者说明](https://github.com/OrderG-X/dsh-design-studio/blob/49a42f0c64f1b496b063d7a6b36c00e778a7e0fd/README.md) · [包清单](https://github.com/OrderG-X/dsh-design-studio/blob/49a42f0c64f1b496b063d7a6b36c00e778a7e0fd/package.json) |
| **Uid-762 / dsh-ai-workbench 0.8.3**，提交 `f472a82` | 自然语言澄清后生成可保留的 HTML 窗口，支持继续修改、模板及导入导出。 | `engines.dsh` 声明通过。参考其澄清式制作体验；生成界面的受控两层契约、独立系统身份与安装包由本方案提供。[作者说明](https://github.com/Uid-762/dsh-ai-workbench/blob/f472a8266d7977cffe1de946da0efedf/README.md) · [包清单](https://github.com/Uid-762/dsh-ai-workbench/blob/f472a8266d7977cffe1de946da0efedf/package.json) |

### 交互与架构参照

- **赋范 DeepSeek Harness Studio** 展示了按自然语言查找社区插件、说明推荐理由与应用入口，适合对照方案卡与插件组合体验。[固定提交 README](https://github.com/fufankeji/deepseek-harness-studio/blob/257d429156a243517a2cafdff777125cd3fb6d54/README.md)
- **kkkkkklze / dsh-plugin-manager** 展示了插件整合包的切换、导入导出和失败回退，适合参考双槽切换与异常恢复交互。[固定提交 README](https://github.com/kkkkkklze/dsh-plugin-manager/blob/ab17c3b5f972c4f4ebb1a6c64026338ddf080c20/README.md)
- **腾讯 WorkBuddy** 提供「从任务进入、实际处理文件、交付可重开结果」的办公工作台参照。[腾讯云 WorkBuddy 产品页](https://cloud.tencent.com/product/workbuddy)
- **声明式生成界面目录（A2UI / json-render）与 CaMeL** 验证了「受控闭集组件目录 + 类型化 JSON 契约 + 控制流/数据流硬分离」优于直接生成任意前端代码，对应 `packages/product-spec` 与视觉提取污点隔离。[Google A2UI 规范](https://a2ui.org/) · [Vercel Labs json-render](https://github.com/vercel-labs/json-render)

<a id="electron"></a>

## 4. Electron 与平台安装身份（实码核验纠偏）

- **Electron 44.11.5 身份与 Fuses**：`app.setName`、`app.setPath('userData' | 'sessionData' | 'crashDumps')`、`setAppUserModelId` 须在 `requestSingleInstanceLock()` 前以不可变 `internalSlug` 调用；共享不可变 `app.asar` 时，Win/Linux 的 `app.getVersion()` 读取 `app.asar` 内模板版本，因此须统一从 `resources/product/identity.json` 读取 `appVersion`。静态 Fuses 在 `base-shell` 固化（Win/Mac 开 `OnlyLoadAppFromAsar` + `EnableEmbeddedAsarIntegrityValidation`，Linux 不支持 ASAR 完整性校验，macOS ad-hoc 禁用 `EnableCookieEncryption` 避免重签触发 Keychain 失效）。[Electron 固定标签的 app API](https://github.com/electron/electron/blob/v44.11.5/docs/api/app.md)
- **`electron-builder@26.18.0 --prepackaged` 实码纠偏**：核验本地 `app-builder-lib@26.18.0` 源码确认：
  - `out/platformPackager.js:149-151` 与 `out/macPackager.js:291-305` 在 `prepackaged != null` 时直接短路 `doPack()`，**会完全跳过 `afterPack`、Windows PE 钤印、Fuses、`applyCommonInfo` 与 macOS `codesign`**，且 macOS `--prepackaged` 须直接传 `.app` 路径本身；故上述步骤必须前移至 `tools/builder` Staging 阶段独立完成，`--prepackaged` 仅作安装器封装。
  - `out/util/resEdit.js` 已改用纯 JS `resedit@1.7.2`（`getRceditBundle` 零调用），配合 `win.signExecutable: false`（`out/winPackager.js:112-115` 短路 `signIf`）与预生成 `.ico`，**无签名 Windows NSIS 打包彻底无需 `winCodeSign` 缓存**，只需离线预置 `NSIS`、`nsis-resources`、`7zip-bin` 与 `app-builder-bin`。
- **NSIS 模板实码陷阱**：
  - `templates/nsis/installSection.nsh:68-83` 在 `customInstall` 之前执行内置 `addStartMenuLink` 且在 L71-75 依 `$newStartMenuLink` 设置 `$launchLink`；`templates/nsis/uninstaller.nsh:254` 在升级期 `customInstall` 之前删除 `HKCU\Software\<guid>`；`templates/nsis/include/allowOnlyOneInstallerInstance.nsh:64-103` 在 PowerShell `Restricted` 策略下回退 `taskkill` 会漏杀内嵌 `node.exe` 且存在单引号路径拼接 Bug；`out/targets/targetUtil.js:40-42` 与 `NsisTarget.js:275` 依赖 `package.json#name`。故须禁用内置快捷方式、同步设临时 `package.json#name = internalSlug`、在 `customInit` 预读旧 `DshSelfShortcutPath` 与 `DataSchemaVersion`、覆写 `customCheckAppRunning` 按精确 `$INSTDIR\` 结束进程、在 `customInstall` 清理/消歧并覆写 `$launchLink`。
- **Linux 与 macOS 平台分发实情**：
  - Linux `out/targets/FpmTarget.js:215` 写死 `/opt/${sanitizedProductName}` 且 `LinuxTargetHelper.js:184-200` 读 `desktopName`，须均锁定为 `internalSlug`；Ubuntu 24.04+ `kernel.apparmor_restrict_unprivileged_userns=1` 下 `out/targets/appimage/appImageUtil.js:223-225` 会静默追加 `--no-sandbox`，故以 `.deb` 为主推形态。
  - macOS 通过 `CFBundleName` 查找 4 个 Helper（`out/electron/electronMac.js:99-142`），主包与 4 Helper 统一用 ASCII `internalSlug` + `.localized`/`InfoPlist.strings` 本地化展示名，禁止 `codesign --deep` 改为由内向外全量重签；无商业证书包在经网络传输带 Windows MoTW（及 Win11 Smart App Control）或 macOS `com.apple.quarantine` 时会受系统拦截，商业签名与公证另设发布阶段。[26.18.0 的 NSIS 实现](https://github.com/electron-userland/electron-builder/blob/e2a8604535bdc626bd068ddf5b6afb67bed45725/packages/app-builder-lib/src/targets/nsis/NsisTarget.ts) · [electron-builder CLI 与 prepackaged 文档](https://www.electron.build/cli) · [NSIS 配置文档](https://www.electron.build/nsis/)

## 5. 按原版本复核

从本机任意 PowerShell 目录执行下面的只读命令，可在两个仓库切换分支或升级后复查原始依据。

```powershell
git -C C:/WorkSpace/OctoDEepSeeK show 48f3f01961d34509bc85245dadc6dfdaede9b65b:apps/desktop/electron-builder.yml
git -C C:/WorkSpace/OctoDEepSeeK show 48f3f01961d34509bc85245dadc6dfdaede9b65b:apps/desktop/src/host/launch.ts
git -C C:/WorkSpace/OctoDEepSeeK show 48f3f01961d34509bc85245dadc6dfdaede9b65b:scripts/qianshou-preview.mjs
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/boot/app-boot/src/plugin-compatibility.ts
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/boot/app-boot/src/profile-resolution/resolver.ts
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/bundle/base/cordis.patch.yml
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/bundle/web-app/cordis.patch.yml
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/client/connection/src/rpc-host.ts
git -C C:/WorkSpace/Reference/deepseek-harness show dsh-v0.2.2-rc.5:packages/experimental/creation-recommendations/src/generated-bundle.ts
```

要复核社区候选，读取上表对应提交的包清单，先记录 `engines.dsh` 或 `@deepseek-ai/dsh*` peer 是否存在，再在 OctoDeEpSeeK 已准备的 `apps/desktop/runtime` 中导入 `@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion` 和 `evaluatePluginCompatibility` 核对返回结果，并额外校验 `@deepseek-ai/cordis`、`react`、`!!js` 补丁用法及平台/Node/`--ignore-scripts` 约束。目录中严格区分「未声明」「声明匹配」与「实测通过」，动态验收以实施方案第 7 节的业务产物与 SLO 为准。
