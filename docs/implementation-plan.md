# dsh-self 专属桌面客户端生成器实施方案

规划日期为 2026-11-22。桌面模板取自 OctoDeEpSeeK `48f3f01961d3`，宿主固定为 dsh `0.2.2-rc.5`。本文描述待开发的功能、契约与验收红线，已有能力与上游源码实证见[参考项目与文档](references.md)。

## 1. 用户最终拿到什么

用户在官方 `dsh@0.2.2-rc.5`（`dsh web` 或官方桌面端，亦兼容 OctoDeEpSeeK）里安装并打开「制作我的客户端」（`dsh-self-studio`），说出用途，附上设计稿或参考网页。生成器列出要用的插件及理由，通过独立子进程启动可操作的隔离桌面预览。用户可以继续说「首页按截止日排序」「把批注放到右边」。满意后点「生成安装包」，得到一款有自己名称、图标、数据目录和业务首页的桌面应用。

首版目标是 **Windows x64 独立安装包**。用同一生成器产出「青禾投标」和「青禾设计室」，在一台没有开发工具的电脑上同时安装、同时启动，各自保存工作并在重启后恢复；后续也可在制作器内调整并重新出包覆盖升级。安装包自带 Electron、Node、dsh 和锁定的业务插件。需要模型或业务账号的功能在成品内配置；未配置模型时，本地导入、预览、批注与导出立即可用，首页就绪条标明待配置的模型或账号并直达对应设置入口。首版产出为无商业证书的本机/内测包（经网络或 IM 分发时会触发系统未签名提示，公开商业签名与公证另设发布阶段）。随后沿用同一份产品定义，为 Linux、macOS 建立各自的原生构建和验收流程。[原项目打包与验证记录](references.md#desktop)

**实现顺序**是先让一份人工填写的产品定义产生可安装软件，再接自动选型、设计理解和对话修改。这样第一轮就能发现安装包互相覆盖、改名升级残留快捷方式、预览与成品加载不同插件等问题。

## 2. 从一句话到安装包

| 用户界面 | 用户操作与系统响应 | 可检查的结果 |
|---|---|---|
| 新建客户端 | 接收文字、语音转写、PNG/JPEG/WebP 和参考网址。区分「照这张图做我的工作台」与「把这张图放进工作台继续设计」。也支持导入既有 `product.json` 开启二次迭代升级。 | 显示原始素材、用途、目标平台、主要任务、期望产物。用户可改转写或素材用途。 |
| 确认需求 | 将「类似 WorkBuddy」展开为具体动作。例如「导入招标文件、找出截止日、导出逐条响应表」。仅在答案会改变工作流时追问，如「需要查标讯，还是处理已经拿到的招标文件？」 | 可编辑的必需动作、可选动作、视觉约束及验收样例。保留这些结论来自哪句话、哪张图。 |
| 查看方案 | 每项能力标明由哪个插件或内置组件提供、为什么选、信任分级、属于纯前端视图包还是本机 Host 包、需要什么外部服务或账号。用户可以换候选、去掉日历、改名称和图标。 | 显示版本、取舍、实测层级、Host 完整权限披露与待接入能力。缺少必需能力时允许先看布局，说明仍待实现的动作。 |
| 试用预览 | 打开成品模板的独立窗口，对照旁边的参考图，切换明暗和窗口宽度，直接跑样例。文案、配色与分区排序修改即时热刷新；插件锁或 Host 补丁变更时重启预览 Host。预览窗口锁定插件写操作，能力调整统一回到方案页。 | 显示当前修订、来源、可点击入口、操作后实际写出的文件，以及哪些外部服务使用了样例。可以恢复上一个修订。 |
| 生成和安装 | 用户选定已验收的修订和目标平台，查看构建进度，打开安装包所在目录。失败后从该修订重试，界面明示当前产物为「未签名测试/内测包」或「已签名分发包」。 | 安装包、SHA-256、版本与构建记录。制作器退出后，安装好的客户端仍可单独使用。 |

**输入与抓取安全边界。** 语音复用 dsh 可选的本地转写，结果先进入可编辑文字。上传设计图前先校验当前模型是否声明 `image` 输入模态；不支持或路由不可用时保留附件，本地提取源图主色生成主题种子，改用预设骨架与表单补齐动作。视觉与网页结构提取在**无工具权限的独立模型调用**中完成，并落实 **CaMeL 风格双通道污点隔离**：输出严格拆分为 `controlSafe`（闭集布局骨架枚举、`sectionIds`、能力意图枚举与 `#RRGGBB` 种子色）和 `taintedDisplay`（从外部图/网页抽取的展示文案）。规划 LLM **仅读取 `controlSafe` 与用户直输文本**，绝不将未确认的 `taintedDisplay` 或外部长文本回流规划上下文；`taintedDisplay` 仅进入制作器 UI 草案，待用户人工编辑确认后去污，且下游生成 NSIS/YAML/Plist/HTML 一律走结构化序列化与转义（零字符串拼接）。包名与版本仅由目录选型器从受控白名单解析。参考网址抓取在**独立抓取子进程**中执行（确保 `dsh web` 与官方桌面端一致可用），采用**双层防 SSRF / DNS 重绑定防线**：① 抓取子进程临时启动 `127.0.0.1:0` 受控代理（要求单次随机 `Proxy-Authorization`），仅放行 `http/https` 与 `80/443` 端口，经 WHATWG URL 归一化后对 `dns.lookup(..., { all: true })` 返回的全部 A/AAAA 记录拦截 IPv4/IPv6 私网、回环、`0.0.0.0/8`、CGNAT（`100.64.0.0/10`，含云元数据）、链路本地、ULA、NAT64/6to4/Teredo 及 IPv4-mapped IPv6；直连时单次解析并直拨已校验公网 IP（保留 TLS SNI/`Host`）；存在系统上游代理时校验代理端口非本机 dsh/Studio/预览端口且本地预解析拒绝内网目标（并明示企业上游代理自身解析权的信任边界）；② 浏览器抓取层（独立无头/隔离 Electron 会话）使用非持久化 `session.fromPartition('ephemeral-...', { cache: false })`、`sandbox: true`、`proxyBypassRules: '<-loopback>'` 与 `disable_non_proxied_udp`，同时挂载 `webRequest.onBeforeRequest` 与 `onBeforeRedirect`（补齐 HTTPS `CONNECT` 隧道内重定向及子资源校验）、禁用 ServiceWorker、取消 `will-download`、全量拒绝权限与设备请求，并设总超时与响应体上限超时强杀（无浏览器环境回退受控代理纯 HTTP 结构提取，需登录站点一键回退上传画板截图）。开发与 CI 用预置转写、截图和结构化回答重放，语义识别质量另用经过授权的真实模型评估。[图片、语音、网页抓取安全依据](references.md#input)

## 3. 工程怎么拆

在 `dsh-self` 独立开发，以固定提交引入桌面模板并记录来源。**硬约束：`dsh-self-studio` 必须作为可在官方 `dsh@0.2.2-rc.5`（`dsh web` / 官方桌面端）直接安装运行的标准自包含 bundle**——打包产物不含任何 `workspace:*` 依赖，显式声明 `engines.dsh: ">=0.2.2-rc.5 <0.3.0"`，不依赖 OctoDeEpSeeK 私有 API（仅使用官方 `ctx.connection.rpc`/`fetch`、`ctx.slots`、`ctx.locale`、`ctx.layout`、`ctx.uiWorkspace` 等公开原语），且**预览、参考网页抓取与构建打包均通过独立子进程驱动**（不耦合宿主 Electron 主进程）。下列目录与接口均为拟新增。

| 模块 | 放什么 | 职责 |
|---|---|---|
| `packages/dsh-self-studio` | 一个标准自包含 dsh bundle（产出自包含 `dist/` 与 `lib/`，零 `workspace:*`，声明 `engines.dsh`），含 Host 入口、React 18 客户端、双语文案及制作流程的 Skill | 仅调用官方 `dsh@0.2.2-rc.5` 公开接口；客户端提供素材、选型、修订、实时预览与构建界面。Host 通过独立鉴权通道 `ctx.connection.rpc.handle('/dsh-self-studio', ...)` 与 `ctx.connection.fetch.register` 承接同源调用（绝不抢占 `/api` Gateway 拦截槽），以独立子进程驱动隔离预览、受控代理抓取与 `tools/builder` 构建。 |
| `packages/product-spec` | JSON Schema、A2UI 风格闭集组件/动作注册表、身份冻结校验、迁移与修订计算 | 定义 4 种页面骨架预设（`single-column`、`list-detail`、`three-pane`、`dashboard-grid`）、闭集 `WIDGET_CATALOG`/`ACTION_REGISTRY`/只读数据绑定枚举与 8 项亮暗语义种子色（强制 `#RRGGBB`，零任意布局树、零脚本表达式、零 raw HTML/CSS），校验不可变身份与可变品牌分离规则。 |
| `packages/catalog` | 版本化且分信任级的能力目录、兼容与冲突规则、插件适配器及其测试 | 从可信索引发现包，执行四步静态准入与六维冲突检查，计算覆盖用户动作的最小组合并披露运行边界。 |
| `templates/desktop` | 从 OctoDeEpSeeK 提取的 Electron 主进程、dsh Host、主题、自有壳与客户端构建器 | 同一个模板运行预览与成品，与预览态共享同一 Spec 解析器与主题派生纯函数。因 esbuild `format: 'cjs'` 不支持 splitting，扩展 `dsh-client-build` 将 `src/client.<name>.ts(x)` 分别编译为带 `chunk` 元数据的自包含异步 chunk 供 `require.async` 加载，并校验 `dsh.client.external` 对齐。 |
| `tools/builder` | 独立信任根的本机构建程序、预编译只读 `base-shell` 与离线 `builder-toolchain` | 独立复核 `product.json`、身份不可变性与平台锁完整性；在 Staging 阶段完成各平台二进制钤印、权限修正与签名，再调用 `electron-builder --prepackaged` 仅封装安装器并检验产物。作者端可按内置哈希清单下载校验离线工具包或直接使用预置副本，终端用户只安装生成的应用。 |
| `fixtures/`、`tests/` | 两种业务样例、安全回归、上游契约守卫、预览端到端、安装及升级测试 | 覆盖从原始需求到产物重开、改名升级、自动回滚与异常阻断的全流程，保存结构化断言结果、SLO 指标和归档截图。 |

制作插件通过 Host 启动固定路径的本地构建程序，采用结构化标准输入输出及任务 ID 通信。渲染进程只提交「开始预览、取消、构建这个修订」等操作。`tools/builder` 启动任务时一次性快照并哈希锁定的 `product.json` 与目标平台锁文件（防并发 TOCTOU），独立重验 Schema、身份不可变性、目录白名单与 SHA-512，不信任制作器渲染态或 LLM 输出；全部命令参数由程序以 `shell: false` 构造且子进程采用最小环境变量白名单。独立成品只携带桌面模板和选中的业务能力。[源码入口与改造位置](references.md#octo)

```mermaid
flowchart LR
  brief["需求和设计稿"] --> studio["制作插件与选型器"]
  studio --> spec["已保存的产品定义与分平台锁"]
  spec --> preview["独立 Session 的隔离桌面预览"]
  preview --> report["绑定该修订的样例报告"]
  spec --> stage["Staging 钤印/重签/构种"]
  report --> stage
  stage --> wrap["electron-builder --prepackaged 封安装器"]
  wrap --> app["可独立安装的客户端"]
```

### 产品定义与修订

| 记录 | 关键字段 | 怎样使用 |
|---|---|---|
| `brief.json` | 原始指令引用、素材用途和摘要、角色、输入、必需动作、可选动作、期望产物、样例 | 对话生成，用户可改。原始附件单独存于制作项目，默认不随成品分发。 |
| `product.json` | `schemaVersion`、`revision`、`appVersion`、可选 `supportedTargets`、创建时一次派生并冻结的 `identity`（`productId`、`internalSlug`、`appId`、`appUserModelId`、`nsisGuid`、`executableName`、`userDataDirName`）、随修订可改的 `brand`（双语 `displayName`、`iconSha256`）、`theme.seeds.{light,dark}`（8 项语义种子色）、`shell` 与 `home` 骨架配置、动作/连接声明、`acceptance` 断言 | 跨平台唯一产品源契约（不含单一构建 `target`，目标平台在构建时指定）。`internalSlug` 强制匹配 `^[a-z][a-z0-9-]{0,11}-[a-f0-9]{8}$`（最长 21 字符，无英文短名时回退 `app-<shortId>`），后续修订禁止篡改 `identity`。`displayName` 限长 `<= 64` 字符并剥离控制字符。装配时投影写出 `resources/product/identity.json` 供主进程在单实例锁前同步读取。 |
| `locks/plugins.<platform>-<arch>.lock.json` | 目标系统与架构、宿主与模板版本、受管包名与准确版本、来源及 SHA-512 完整性、传递依赖锁摘要、启用顺序、动作提供者、连接前置条件 | 按目标平台分文件锁定，避免跨平台构建互相覆盖。npm 记录完整性值，Git 来源固定到完整仓库路径、提交 SHA 和可验证归档；同步导出 `seed-manifest.json`（含 `profile-seed.tar.gz` 的 SHA-256 `seedHash`）标记受管核心包。 |
| 预览报告、构建回执 | 修订、目标平台、产品定义与锁摘要、`seedHash`、模板/工具版本、样例结果、模拟服务、包路径和 SHA-256 | 查明这份安装包对应哪一次预览、用哪些样例试过，支持重建、二次迭代与失败重试。 |

一份跨平台投标产品的定义示例如下：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "appVersion": "0.1.0",
  "supportedTargets": ["win32-x64"],
  "identity": {
    "productId": "8a7cca35-a871-4c40-a0d8-ac139826b7ef",
    "internalSlug": "qinghe-bids-8a7cca35",
    "appId": "app.dshself.u8a7cca35",
    "appUserModelId": "app.dshself.u8a7cca35",
    "nsisGuid": "8a7cca35-a871-4c40-a0d8-ac139826b7ef",
    "executableName": "qinghe-bids-8a7cca35",
    "userDataDirName": "qinghe-bids-8a7cca35"
  },
  "brand": {
    "displayName": { "zh": "青禾投标", "en": "Qinghe Bids" },
    "iconSha256": "6b2c9f14a0e3d8b15f7c2e4198a0b3d4c5e6f708192a3b4c5d6e7f8091a2b3c4"
  },
  "theme": {
    "seeds": {
      "light": {
        "canvas": "#f8fafc", "surface": "#ffffff", "ink": "#0f172a", "mutedInk": "#475569",
        "accent": "#0f766e", "border": "#cbd5e1", "danger": "#dc2626", "ok": "#15803d"
      },
      "dark": {
        "canvas": "#0f172a", "surface": "#1e293b", "ink": "#f8fafc", "mutedInk": "#94a3b8",
        "accent": "#2dd4bf", "border": "#334155", "danger": "#f87171", "ok": "#4ade80"
      }
    }
  },
  "shell": {
    "defaultPanel": "home",
    "navOrder": ["home", "bidkit-workbench"],
    "showReadinessBar": true
  },
  "home": {
    "layout": "list-detail",
    "sections": ["deadlines", "missing-materials"],
    "primaryAction": "bid.importRequirements"
  },
  "requiredActions": ["bid.importRequirements", "bid.exportResponseDocx"],
  "optionalActions": ["calendar.addDeadline"],
  "acceptance": {
    "fixtures": ["bid-sample-valid.docx", "bid-sample-scanned.docx"],
    "expectedOutputs": ["responses/*.docx"]
  }
}
```

每个动作在目录中关联输入类型、结果类型、执行方式、所需连接和样例断言。制作 Host 提供 `saveBrief`、`resolvePlugins`、`startPreview`、`buildClient` 与 `getJob` 等接口。修改请求携带预期修订号，过期的结果不能覆盖后来的修改。每次构建以产品、修订、目标平台、锁和工具版本为键，重复点击复用同一任务。取消及崩溃仅影响该任务的临时目录，成功后再原子发布产物。

## 4. 自动选插件的具体规则

1. **把需求翻译成能力与三类标准动作。** 模型可提出「标书解析」「逐项响应」「Word 导出」等能力意图，选型器从受控目录解析包名、版本和来源。UI 控件仅绑定三类符合 `dsh@0.2.2-rc.5` 真实原语的动作：`panel-open`（调 `ctx.layout.selectPanel(panelId)` 无参切换主面板，或经 `sidebarRight.openResource` 打开工作区文件）、`host-service`（经受测薄适配器通过 **Typert Remote 或 `ctx.connection.fetch.register`** 暴露受鉴权与 Origin 栅栏保护的确定性文件导入、校验与导出接口；严禁直接注册裸 `ctx.webServer.register('/api/...')` 绕过鉴权）、`seeded-session`（调 `ctx.uiWorkspace.startSession` 预填草稿与材料发起会话，仅限 AI 辅助生成动作，不单独承载确定性文件读写）。
2. **四步静态准入、安全扫描与六维冲突过滤。** 对准确版本读取真实 `package.json` 与补丁清单，依次校验：① 具备有效 `dsh.bundle.patch`，扫描 `cordis.patch.yml` 是否使用 `!!js` 标签（社区包命中即升格人工审计）；② `dsh.bundle.platforms`、`os`、`cpu`、`engines.node` 匹配目标系统与 Node `26.12.1`，且仅准入纯 JS/TS 或靠 `optionalDependencies` 预编译 N-API 二进制在 `--ignore-scripts` 下直接运行的包（拒绝依赖 postinstall `node-gyp` 编译的包）；③ 显式核对 `@deepseek-ai/cordis`（`~4.1.0`）与 `react`（`18.x`）peer 范围（弥补宿主 `evaluatePluginCompatibility` 在声明了 `engines.dsh` 时跳过全部 `peerDependencies` 的盲区）；④ 在调用 `evaluatePluginCompatibility` 前先读取原始字段区分「声明匹配」「未声明宿主范围（该函数同样返回 `undefined`，强制标为『待实测』且须通过冷启动与业务样例才可入锁）」「声明冲突」三态，禁止自动写入 `allow-version` 豁免。目录另登记每包的 Cordis `entryIds`、Host `httpRoutes` 前缀、`panelIds`、独占插槽 `exclusiveSlots`、默认快捷键与公开服务名，枚举组合时直接剔除任一维度碰撞的组合。[dsh 索引与兼容算法](references.md#dsh)
3. **信任分级与组合排序。** 目录包分为三级：`builtin`（模板自有积木与薄适配器）> `verified-community`（固定完整仓库/提交 SHA、SHA-512、人工审计且通过目标平台第 7 节样例）> `experimental-unverified`（仅声明或未声明，默认不自动选中，须用户显式展开确认才可试用）。对首版小目录枚举能覆盖全部必需动作的无冲突组合，依次优先高信任分级与同平台样例通过、满足用户的本地或账号限制、需接入的额外服务更少、额外插件更少；同分按固定目录顺序决定。方案页对所有 Host 插件如实披露「运行于宿主进程内、拥有当前系统用户完整文件与网络权限」，并约定自有首页与整页社区插件（如 BidKit）共享工作区内同一项目数据目录，避免双入口状态分裂。
4. **处理缺口与 M5 Creator 双轨边界。** 先在隔离环境验证新候选。首版用自有骨架组件渲染业务首页，用受测试的薄适配器补确定性动作。仍缺少的必需动作保留在方案上，并提供标准 MCP 连接替代指引或允许用户修改范围再导出。M5 扩展局部自定义页面须如实区分安全边界，坚持两条分轨：**默认真隔离轨**输出受控 `product-spec` 积木参数，或运行于无同源权限的 `<iframe sandbox="allow-scripts">`（opaque `null` origin + `connect-src 'none'`），仅经白名单 `postMessage` 读取只读快照并发出已声明动作；**受审原生 `dsh.client` 轨**须明示「共享已认证 Host 同源、不构成安全沙箱」，定位为经人工复核的编译产物——禁止外部 `dependencies` 与 Host 代码，复用上游 `parseDocument(..., { schema: 'core', customTags: [], maxAliasCount: 0 })` 封禁 `!!js` 与 YAML 炸弹，经 AST 门禁禁用危险 API 与越权服务注入，完成业务验收后双锁源码与产物。[Creator 能力与边界](references.md#dsh)

**两条实际选型结果可以校准算法。** 「我手头已有招标文件」应优先试 BidKit 的解析与导出（其 `0.1.0` 缺少 dsh 版本声明，按未声明实测流程准入）并在工作应用保留其完整工作台，首页排序与预览定位由模板自有 `list-detail` 面板驱动且与 BidKit 共享工作区项目目录。「帮我查标讯」才考虑企查查数据源，而 `dsh-tender-workbench@0.5.11` 在当前宿主有 13 项 peer 冲突，应显示原因、留下能力缺口并提示可用标准 MCP 替代。「设计画布、标注和导出」由模板自有 `three-pane` 面板承载可重排的三栏位图批注与确定性导出，`dsh-design-studio@0.28.0`（按完整仓库路径 `OrderG-X/dsh-design-studio` + 提交 SHA 唯一标识）作为通过版本声明的可选 AI 原型画框面板实测共存。`dsh-ai-workbench@0.8.3` 适合参考对话澄清与窗口迭代交互。四者的提交、包清单及复核方法已列入[候选插件核对表](references.md#candidates)。

## 5. 设计稿怎样变成可以试用的预览

**先生成可修改的受控界面描述。** 例如三栏稿被识别为 `three-pane` 骨架下的「项目列表、画布、属性与批注」，用户在结构树里确认每块映射到的模板积木、已有插件面板或待实现项。提取的 8 项亮暗种子色由确定性纯函数统一派生全量 110+ 项 `--dsw-*` 变量及 Electron 原生窗口 `backgroundColor`、`titleBarOverlay` 配色（单一真源防漂移），并自动钳制正文与背景对比度不低于 WCAG `4.5:1`。页面、品牌、入口分别挂在 `main`、品牌插槽和 `sidebar.panellist`，沿用 React 18、CSS Modules 与中英双语。[主题与插槽样例](references.md#octo)

**独立子进程隔离启动并彻底锁死插件写入口。** 草图确认后，制作 Host 以**独立子进程**启动同版本隔离 dsh 预览 Host（以及独立 Electron 预览窗口子进程，或 `dsh web` 下的独立隔离预览页）；预览窗口拥有完全独立的 `userData` 与 Electron Session 分区 `session.fromPartition('persist:preview-<projectId>')` 并默认拒绝全部权限请求，严禁与宿主或 Studio 共享默认 Session，从根源阻断 RFC 6265 下 `127.0.0.1` 跨端口窃取 Studio `dsh-auth-*` Cookie。预览环境不注入 `pnpm` 垫片，且因 Web 模式下 `tool-plugin-manager` 实际嵌套在各 `presets/*.patch.yml` 内部，预览 `--patch` 必须直接禁用 **Host 写服务 `id: plugin-manager`**、`id: ui-plugin-manager` 与 `id: hmr`（保留只读 `plugin-inventory` 核验状态），同时构建期永不回读预览目录，彻底杜绝锁漂移。同一制作项目持久化 `{ preferredPort, fallbackPort, conflictStreak }` 复用本地端口，避免单次瞬时端口冲突改写 Origin 清空 Chromium 本地存储（连续 3 次独立启动确认被外部常驻进程占用才晋升新端口）。邮箱或日历如由 fixture 提供，在控件旁标「样例连接」，分别显示「布局可看」「业务样例已通过」「账号待连接」。

**分级热刷新与白名单快照继承。** 自有壳 Host 通过 `ctx.connection.fetch.register` 暴露受鉴权的只读 `/api/product-spec`，并通过 Typert Remote 事件流推送预览态变更（不另开未鉴权 SSE/WS），前端与成品共享同一套 Spec 解析器：仅改文案、种子色或分区排序时前端直接重绘，秒级生效；涉及 `locks/plugins.*.lock.json` 或 Host 补丁改动时，先停止上一预览 Host，仅按白名单将工作区业务文件、已落盘 `sessions/` 与 `.credentials.yaml` 复制到新修订（严禁复制 `profiles/`、端口、PID、日志、锁及 `-wal`/`-shm`，POSIX 下恢复 `.credentials.yaml` 的 `0600` 权限），新修订的 `profiles/` 始终由新锁干净装配；删除制作项目或清理历史修订时同步销毁临时 `.credentials.yaml` 副本与对应预览 Session 分区存储。前后版本用同一窗口尺寸和样例对照，测试记录绑定定义、锁、目标和模板摘要，用户可随时返回上次通过样例的修订。[现有真实文件与重启恢复测试](references.md#tests)

## 6. 怎样生成真正独立的客户端

| 工程位置 | 当前项目的行为 | dsh-self 的改造 |
|---|---|---|
| 应用身份、只读壳与品牌 | 名称、AppUserModelID、`userData`、快捷方式与卸载显示名写死在源码常量；加载页与品牌组件写死在 `app.asar` 内。 | 保持 `app.asar` 与 `base-shell` **100% 不可变硬链接**，全部产品差异外置到 `resources/product/*`（运行时统一从 `resources/product/identity.json` 读 `appVersion`/`displayName`/`internalSlug` 与品牌资产，不读 `app.getVersion()`，并调 `setAboutPanelOptions` 对齐系统关于面板）。主进程在 `requestSingleInstanceLock()` 前同步依次调用 `app.setName(internalSlug)`、`app.setPath('userData' \| 'sessionData' \| 'crashDumps', ...)` 与 `setAppUserModelId`，并为所有 Session 挂载默认拒绝权限处理器。NSIS 传给 `electron-builder` 的临时 `package.json` 同步将 `name` 设为 `internalSlug`、`version` 设为 `appVersion`；禁用内置快捷方式创建，改由 `installer.nsh` 统一接管：在 `customInit`（早于 `uninstallOldVersion` 删注册表键）预读旧 `DshSelfShortcutPath` 与 `DataSchemaVersion`（安装期即拦截降级覆盖）；覆写 `customCheckAppRunning` 按精确 `$INSTDIR\` 路径安全结束主进程与内嵌 `node.exe`（防 `EBUSY` 与单引号注入）；在 `customInstall` 清洗展示名、清理旧 `.lnk`、跨 GUID 同名自动追加 `(<shortId>)`、写 `WinShell::SetLnkAUMI` 并**显式覆写 `$launchLink`**（防安装后拉起同名他包）。 |
| Host、环境隔离、隐私与首启体验 | 固定启动 `octo` profile 并弹首次空间选择框；`launch.ts` 展开 `...process.env`；打包版默认工作区落入系统文档下 `deepseek-harness/default-workspace`；新 home 首启弹「预览版说明」和「开始使用」登录框，且默认启用会话日志与插件清单上报。 | 移除 `shared` 空间与首启空间选择框，固定独立 `dshHome = <userData>/h`（缩短 `profiles/` 路径前缀）。主进程冷启动先按 `host-pids.json`（核对 PID 与进程创建时间）回收上次异常残留进程；Host 与 `tools/builder` 启动一律采用**最小环境变量白名单**（仅保留 OS 必需项、企业 `HTTP(S)_PROXY`/`NO_PROXY`、`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` 与显式 `DSH_HOME`/`DSH_TELEMETRY_DISABLED=1`，剔除 `NODE_*`/`LD_*`/`DYLD_*`/其他 `DSH_*` 及外部模型密钥），并显式传 `loadLayeredEnv('dsh', dshHome)` 阻断工作目录 `.env` 注入。在种子 `cordis.patch.yml`（绝不放进 `--patch`，避免锁死 `config-editor` 与覆盖用户设置）预置 `ui-settings-general.welcomeNoticeVersion`（构建期断言对齐上游常量）并将 **`session-log-deepseek.enabled` 设为 `false`**（同时关闭 `plugin-package-inventory-deepseek`，因 `DSH_TELEMETRY_DISABLED=1` 无法关闭它们）；纯本地产品默认关闭或审批保护 `tool-web`。通过 `--patch` 设 `ui-settings-models.credentialOnboarding: false` 静默登录引导（严禁伪造 `window.dshDesktop`）；自有壳接管 `settings.launcher` 将 `openSettings('models')` 桥接至首页就绪条。首启在 `<用户主目录>/Workspaces/<internalSlug>` 创建目录并调公开接口 `ctx.workspaceRegistry.create(dir, displayName)` 注册默认工作区，首页与导出回执内置「在文件夹中显示」「另存为」和「更换工作区目录」。 |
| 壳与插件配置层 | 启动叠加层及装配脚本列死两个插件，测试靠跨目录软链补 peer。 | 预览与成品统一经 `entry.ts` 的 `runProfile({ patchFiles, args })` 启动。注意 Cordis patch 对同行 `config` 为整对象替换，覆盖内置行须补全既有键。`--patch` 仅放不可变壳层、遥测与引导收敛项；用户可修改的设置与可启停核心业务包写入 profile 的 `cordis.patch.yml` 与 `dsh.profile.bundles`，通过 `plugins.detail.badge` 标注核心组件，停用后点击对应入口提示一键重新启用。同时记录 `profileContext.name !== 'desktop'` 顺带关闭 `ui-sidebar-browser`、`workspace-dependencies` 并将 `desktopPlatform` 置 `null` 的已知边界。 |
| 三步预打包流水线（修正 `--prepackaged` 职责） | `after-pack.cjs` 拷贝散文件且写死文件名与路径；旧设计误以为 `--prepackaged` 会跑 `afterPack`、PE 钤印与签名。 | `electron-builder@26.18.0 --prepackaged` 会直接跳过 `doPack()`（不跑 `afterPack`、PE 编辑、Fuses 与签名），因此**严格限定其只负责最终安装器封装**，前置由 `tools/builder` 完成三步流水线：① `base-shell` 预固化安全 Electron Fuses（`RunAsNode: false`、`EnableNodeOptionsEnvironmentVariable: false`、`EnableNodeCliInspectArguments: false`、`OnlyLoadAppFromAsar: true`、`GrantFileProtocolExtraPrivileges: false`；Win/Mac 开启 `EnableEmbeddedAsarIntegrityValidation: true`，Linux 不支持该项，macOS ad-hoc 禁用 `EnableCookieEncryption`）；② 在标准用户可写的同卷 `%LOCALAPPDATA%\<studio-slug>\toolchain\.staging\<jobId>`（POSIX 对应用户缓存目录）对只读 `base-shell` 的框架、`app.asar` 与 `runtime/` 建同卷硬链接（跨卷 `EXDEV` 回退复制），**独立复制主可执行文件**并写入 `resources/product/*` 与种子归档；③ 在 Staging 内执行平台钤印与重签，随后再调用 `--prepackaged` 出包。 |
| 各平台钤印、权限与分发边界 | 已有 Windows NSIS x64、macOS DMG（`identity: null`）、Linux AppImage/deb，存在 `/opt/` 与 `.desktop` 同名碰撞及 Ubuntu 24.04 沙箱问题。 | **Windows**：复制主 `.exe` 改名为 `<internalSlug>.exe`，直接调用纯 JS `resedit`（清上游残留签名表并保留 `INTEGRITY/ELECTRONASAR`）钤印 `icon.ico` 与 PE 版本信息；设 `win.signExecutable: false` 后无签名 NSIS 彻底**无需 `winCodeSign` 缓存**；按标准用户权限安装。**Linux**：Ubuntu 24.04+ 默认开启 `apparmor_restrict_unprivileged_userns=1`（AppImage 缺 `libfuse2` 且可能静默降级 `--no-sandbox`），以 **`.deb`** 为主推形态；在 Staging 改名并 `chmod 0755`/`04755`，锁定 `/opt/<internalSlug>` 与 `desktopName = internalSlug` 防跨产品碰撞（`.desktop` 的 `Name=` 填 `displayName`），启动探针检测 `bubblewrap`/AppArmor 可用性并给指引。**macOS**：主 `.app` 与 4 个 Helper `.app` 统一以 ASCII `internalSlug` 作为 `CFBundleName`/`CFBundleExecutable`（中文展示名经 `.localized` + `zh-Hans.lproj`/`en.lproj/InfoPlist.strings` 呈现，改名升级不残留 `/Applications` 路径），重写全部 `Info.plist`（严格 `<appId>.helper.*` 前缀、保留 `ElectronAsarIntegrity`、ATS 仅 `NSAllowsLocalNetworking: true`），`xattr -cr` 后禁止 `--deep`、按「内层 `.node`/`.dylib`/内置 `node` → Frameworks → 4 Helper `.app` → 主 `.app`」由内向外执行 `codesign --force --sign -` 并过 `codesign --verify --deep --strict`，再将 `.app` 路径直接传给 `--prepackaged` 封 DMG。公开商业签名、Windows SmartScreen/SAC 与 macOS `com.apple.quarantine` 公证另设发布阶段。 |

[桌面身份、运行时装配和打包源码](references.md#desktop) · [Electron 与安装器依据](references.md#electron)

**作者端的离线构建工具包。** 离线 `builder-toolchain` 置于 `%LOCALAPPDATA%\<studio-slug>\toolchain\`（保障标准用户同卷硬链接权限），仅携带固定版本 Node、`electron-builder`、`NSIS`、`nsis-resources`、`7zip-bin`、`app-builder-bin`、预编译只读 `base-shell` 与预生成图标生成能力（彻底移除无签名期不需要的 `winCodeSign` 及其符号链接解压风险），下载清单及 SHA-256 内置在 `dsh-self-studio` 中并提供国内镜像回退，全程无需 TypeScript 编译或隐式访问 GitHub。构建前预检磁盘空间、同卷暂存路径和离线材料完整性，缺哪项即显示重试入口。测试在清洁 Windows 标准用户环境分别覆盖「制作器点击导出」「只装成品」以及人工注入 Mark of the Web（MoTW）后的 SmartScreen 预期行为。

**插件交付、原生解析、双槽自愈与防降级。** 删除 `entry.ts` 硬编码的 `registerHooks` 与开发脚本的跨目录 `symlinkSync`，直接复用 `@deepseek-ai/dsh-app-boot` 原生 `PluginPackages` 运行时解析（禁止将 profile 或其 `node_modules` 软链出 `profiles/`，开发态自有插件同步构建至 `runtime/plugins/`）。种子构建固定 `nodeLinker: hoisted`、`autoInstallPeers: false` 与 `--frozen-lockfile --ignore-scripts`，并在种子 `.npmrc` 固化 `ignore-scripts=true`（同步防护成品运行期用户后装扩展），扫描清扫 `<seed>/node_modules` 下混入的任何 `@deepseek-ai/cordis*` 与 `@deepseek-ai/dsh*` 影子副本，macOS 种子禁止未签名第三方 `.node`/`.dylib`（或构种前统一预签），在构建期强制校验归档内 `maxEntryRelPath <= 130`（适配缩短后的 `<userData>/h/profiles/p-<shortHash>`，防未开启 `LongPathsEnabled` 的 Windows 溢出 260 字符）并执行 `runProfile` 冷启动探针，打包为单文件确定性归档 `profile-seed.tar.gz` 并记录 `seedHash` 写入 `seed-manifest.json`。首启与升级**以 `seedHash` 变化为换槽触发条件**（确保同 `appVersion` 仅改布局/锁覆盖安装也能更新）：先校验 `profile-seed.tar.gz` 的 SHA-256，再用支持 PAX 扩展头的流式解包器（限制条目数/单文件/总解压字节/深度防炸弹，拒绝越界路径、软硬链接、设备/FIFO、Windows 保留设备名、NTFS ADS、末尾点空格及大小写碰撞）解压到临时目录后原子重命名为 `<userData>/h/profiles/p-<shortHash>`（避开触发桌面遥测的 `'desktop'`），经原子写入 `active-profile.json`（记录 `{ active, previous, state, bootAttempts, dshRuntimeVersion, failedSlotHash }`）切槽并最多保留两槽。升级时保持旧槽不动（零 `EBUSY`），对旧槽 `cordis.patch.yml`（特别是 `ui-settings-general`）执行键级深合并并迁移 `compatibility.json`；若新槽连续 2 次冷启动未通过健康探针（Host 就绪 + `/api/product-spec` 200 + 核心包无激活报错 + 主窗口就绪），且 `previous.dshRuntimeVersion === currentDshRuntimeVersion`，则自动回退 `previous` 并标记 `failedSlotHash`（跨宿主大版本不兼容则降级仅挂核心壳的安全模式并引导导出诊断包）。若检测到 `dependencies \ managedBundles` 存在用户后装扩展，启动后在插件页非阻塞提示用本地 `.pnpm-store` 恢复。同时在 `<userData>/state-version.json` 记录 `{ dataFormatVersion, dshSessionFormatVersion, lastAppVersion }`（联动 NSIS `customInit` 的 `DataSchemaVersion` 预检），阻止旧版覆盖降级高版本数据。POSIX 下强制 `0600` 保护 `.credentials.yaml`、`host-pids.json`、`active-profile.json`、`logs/*.log`，`0700` 保护 `logs/`。

**产物验证、隔离预览与脱敏诊断。** 预览、构建与安装后三处比对产品定义、平台锁、`seedHash` 和模板版本，安装包 SHA-256 写入外部构建回执。内嵌 Word 预览采用经 `require.async` 按需加载的 `client.docx-viewer.js`（封装 `docx-preview`，传 `renderAltChunks: false, useBase64URL: true, renderChanges: false`），先经 DOMPurify 白名单清洗（显式放行 `<style>` 并剔除外部 `@import`/`url()`），再渲染于**无同源权限的 `<iframe sandbox="allow-scripts" srcdoc>`**（opaque `null` origin，配合 `default-src 'none'; script-src 'nonce-<rand>'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'` 严格 CSP 与极简 `nonce` 桥接脚本），通过校验 `e.source` 的白名单 `postMessage` 块路径与父页双向联动，彻底隔离恶意标书与已鉴权 Host 同源上下文；导出后独立解压回读 `word/document.xml` 校验内容。成品「帮助」菜单内置一键导出脱敏诊断包，打包前 `lstatSync` 校验白名单文件均非符号链接且为普通文件，收集 `identity.json`、`product.json`、`plugins.*.lock.json`、`active-profile.json` 与经扩充规则（覆盖各类模型/云 API 密钥、`Bearer`、JWT、PEM 私钥、代理鉴权、会话 Cookie、内嵌凭据 URL 与本机用户名路径）脱敏后的 `logs/*.log`，物理排除 `.credentials.yaml`、`.env*`、会话记录、浏览器存储、`crashDumps` 与工作区原件。[原项目 Office 探针及日志脱敏依据](references.md#desktop)

## 7. 用什么证明做好了

| 样例 | 输入与动作 | 通过条件 |
|---|---|---|
| 青禾投标 | 输入「做投标文件，不查标讯」和一张首页草图。分别导入含评分项、缺失资质、截止日、内容控件（`w:sdt`）、嵌套表格与修订删除项（`w:del`）的脱敏 DOCX，以及一份无文本层的扫描型 DOCX（另测含贴图评分表的图文混合件）。 | 扫描型 DOCX、旧版 `.doc` 或加密文档明确阻断并提示原因，图文混合含贴图评分表给出降级告警，绝不产出空响应表。Host 解析强制 ZIP 炸弹四重配额，禁 XXE，剥离 `w:altChunk`、`TargetMode="External"`、`w:instrText`/`w:fldSimple` 外部域、`javascript:`/`file:` 与 Windows UNC 路径（防 SMB/NTLM 外泄），忽略 `<w:del>`，以 `docSha256 + 递归 OOXML 块路径（含 w:sdt/嵌套表/页眉）+ 摘录短哈希`（`w14:paraId` 辅助）并注入确定性 `<w:bookmarkStart>` 锚点；前端在 opaque-origin 沙箱 `<iframe>` 中实现双向高亮跳回原文，生成可重开的 `.docx` 响应草稿且解压回读校验通过，安装版重启后恢复同一项目。 |
| 青禾设计室 | 提供一张目标工作台图和一张带 EXIF 旋转标签的高分辨率作品图（含 `2000×40000` 超长图样例）。要求「左边项目、中间画布、右边批注」，预览中改一次布局、加一条贴边批注并导出。 | 自有 `three-pane` 面板按工作台图渲染并支持布局热重排，`dsh-design-studio` 可共存打开。前端画布通过 Host 限边预览代理图绕过 Chromium `16,384 px` GPU 纹理上限，原图只读保留，批注以 `[0, 1]` 归一化坐标写入 `.annotations.json`。Host 仅接收位图输入（拒未受控外部 SVG），设显式 `limitInputPixels` 与 `sequentialRead: true`，经 `.autoOrient()`/`.rotate()` 归一化 EXIF 方向（5–8 互换有效宽高）并基于内嵌 ICC 正确转换 sRGB，以**逐标注小块纯几何 `<path>` SVG 徽标**（钳制 `left ∈ [0, W-badgeW]`、`top ∈ [0, H-badgeH]`）经 `sharp.composite` 离屏合成导出 PNG（彻底规避 Cairo `32,767 px` 硬上限），像素尺寸与标注位置零旋转错位，重启后仍可编辑原批注。 |
| 同机并存、同名消歧、改名升级与防降级 | 无模型凭据下安装两款产品（再测第三款与投标版同名 `displayName` 但不同 GUID 的产品）并同时打开，各自写入带标记资料。给投标版改展示名、升版本覆盖安装，再测同版本号仅改 `seedHash` 覆盖升级、故障槽 2 次冷启自动回滚、旧版安装包降级拦截，最后仅卸载投标版。 | 首启无上游免责声明、登录弹窗或默认会话日志外发，本地能力立即可用且就绪条可直达模型设置。按 `nsisGuid` 核验注册表：同名不同 GUID 不覆盖前包 `.lnk`、自动追加 `(<shortId>)` 且 `$launchLink` 拉起本包；改名升级后旧名 `.lnk` 已清除、新 `.lnk` 含正确 `AppUserModelID` 且原工作区资料完整找回；同版换 `seedHash` 正常切槽，连续 2 次启动失败自动回退同宿主 `previous` 槽；旧版安装包在 NSIS `customInit` 即被拦截（跨平台由 `state-version.json` 拦截）不损毁数据；卸载投标版后设计室正常启动且数据完好。 |
| 失败、安全与恢复 | 给出宿主冲突包、需登录网址、指向 `127.0.0.1:<dshPort>` 的 DNS 重绑定与 HTTPS 30x 跳转测试源、含提示注入字样的参考图、含 XSS 载荷的恶意 DOCX、预置 `NODE_OPTIONS`/`DEEPSEEK_API_KEY` 的宿主环境、预览侧探测 Studio Cookie 与裸 `/api`、下载中断及导出重复点击。 | 解释具体缺口并提供回退/MCP 指引；双层防线阻断回环与 HTTPS 重定向探测；恶意图文无法影响规划 LLM 选型或绕过目录白名单；恶意 DOCX 无法突破 opaque iframe 触碰宿主 `/api`；预览窗口无法读取 Studio `dsh-auth-*` Cookie 且无法通过预设内 `tool-plugin-manager` 篡改锁；子进程环境与 `session-log-deepseek` 无泄漏；旧修订和已发布产物可重开，同一构建请求仅产生一份有效回执。 |

**核心工程 SLO 红线（纳入自动化回归）：**

| 指标 | 目标红线 | 验收口径 |
|---|---|---|
| 安装包与种子体积 | Win x64 NSIS `<= 320 MB`，单产品 `profile-seed.tar.gz <= 80 MB` | M0/M4 产物构建回执断言 |
| 成品启动耗时 | 首启（含流式解包）P95 `<= 15 s`；日常冷启 P95 `<= 4 s` | 清洁 Windows 标准用户冷启至主壳就绪 |
| 预览交互耗时 | 配色/文案/排序热刷新 P95 `<= 1 s`；改锁冷重启 P95 `<= 12 s` | 预览端到端回归计时 |
| 增量打包耗时 | 预热 `base-shell` 同卷硬链接 + 离线工具链 P95 `<= 60 s` | 作者端导出全流程计时 |
| 业务处理耗时 | 50 页/20 MB DOCX 解析与首屏渲染 `<= 3 s`；`2000×40000` 超长图导出 `<= 8 s` | M1/M4 业务样例夹具断言 |

仓库开发测试在 `.dev/` 或临时目录运行，并建立集中式 `upstream-contract.test.ts` 守卫上游 `dsh@0.2.2-rc.5` 关键常量与模块契约。生成客户端淘汰原双空间开关，统一使用产品测试环境变量组（覆盖 `userData`、`dshHome` 与 `Workspaces` 根目录），清理预览时只结束该任务记录且创建时间匹配的 PID。另用一次性标准权限测试用户或虚拟机（覆盖 `LongPathsEnabled=0`、长/中文用户名及含空格路径）在**无任何测试环境变量的正式默认配置**下验证两款产品隔离、升级与人工注入 MoTW 的分发表现。自动化界面验收固定窗口 DIP 尺寸、`--force-device-scale-factor=1` 与注入时钟，另增 `125%` DPI 抽检（验证画布坐标映射与 `titleBarOverlay` 无遮挡），以可访问性角色树、控件包围盒无遮挡断言及落盘文件结构化回读作为通过判据，截图归档留证。真实模型图稿理解及外部账号连接在另行授权的验收环境单独评估并分账记录。[现有验收命令与证据](references.md#tests)

## 8. 开发顺序与每阶段交付

| 里程碑 | 具体交付 | 结束时可以演示什么 |
|---|---|---|
| M0　桌面模板、三步预打包与双槽基线 | 不可变硬链接 `app.asar` + 安全 Fuses 固化、`tools/builder` Staging 纯 JS `resedit` 与 `--prepackaged` 封包、最小环境白名单、种子 `welcomeNoticeVersion` + `session-log-deepseek: false`、`~/Workspaces/<slug>` 工作区注册、`<userData>/h/profiles/p-<hash>` 双槽（含 `seedHash` 换槽与自动回滚）、NSIS `customInit`/`customCheckAppRunning`/`$launchLink` 完整宏。准备两份手写 `product.json`（按先单包闭环、再双包并发/改名/降级分段验收）。 | 在清洁 Windows 标准用户（含 `LongPathsEnabled=0` 与长/中文用户名）正式默认配置下安装两个及同名第三客户端，无凭据零弹窗同时运行、互不串数据、无会话日志外发；改名升级清理旧快捷方式并找回原资料，同版换锁生效，故障槽自动回滚，安装期防降级与单边卸载全部通过。 |
| M1　目录、冲突检查与安全业务适配 | 建立动作契约（`connection.fetch.register`/Typert Remote）、三级信任目录、四步静态准入（含 `!!js` 与 `--ignore-scripts` 原生门禁）、六维冲突表、分平台锁及影子包清扫探针；扩展 `dsh-client-build` 独立异步 chunk；实测候选包，落地 OOXML 书签定位 + opaque-iframe `docx-preview` 与 `sharp` 分块无字体几何批注合成适配器。 | 结构化需求自动选中可运行组合，准确拦截 13 项 peer 冲突与路由/快捷键碰撞。两条业务样例分别完成含扫描件/恶意 XSS 阻断的 `.docx` 双向定位导出与 EXIF 旋转超长图批注 PNG 导出，达成核心 SLO。 |
| M2　需求、安全抓取与设计输入 | 制作插件、受约束会话工具、模型 `image` 探针、双层 SSRF 代理与会话拦截、CaMeL `controlSafe`/`taintedDisplay` 污点分离、8 项种子色对比度统一派生、最少追问及方案卡片编辑（含 Host 权限披露与 MCP 缺口指引）。 | 一段需求和两种不同用途的图安全进入 `product.json`，恶意图文与 HTTPS 30x 回环跳转均被阻断且无法绕过目录白名单。改变「写标书」为「查标讯」会改变选型结果。离线重放与真实语义评估分账记录。 |
| M3　隔离热预览、快照与二次迭代闭环 | 启动独立 Session 分区的隔离预览窗口，禁用 `plugin-manager`/`ui-plugin-manager`/`hmr`（保只读 `plugin-inventory`），固定项目端口池，接入受鉴权 `/api/product-spec` + Typert Remote 热刷新、冷重启白名单快照继承（含项目删除清凭据）、样例连接标记、修订回退及导出/重导 `product.json` 二次迭代流程。 | 预览与 Studio Cookie 完全隔离、Agent 无法篡改插件锁；改配色与排序 `<= 1 s` 热刷新，改能力组合平滑重启并保留已试用业务文件，随时回退修订并能对已装成品重新出包覆盖升级。 |
| M4　作者端离线导出与诊断 | 封装置于 `%LOCALAPPDATA%`、无 `winCodeSign` 依赖的离线 `builder-toolchain`（内置哈希清单、镜像回退、环境预检、输入快照防 TOCTOU、并发任务锁、外部回执、分发状态标识）及成品防符号链接脱敏诊断包。 | 无开发工具的作者点击导出在 `<= 60 s` 内生成标准 NSIS 安装包，在清洁机与人工注入 MoTW 场景下通过第 7 节全部业务、安全、SLO、升级与脱敏诊断包验收。 |
| M5　跨平台原生包与双轨受控扩展 | 为同一 `product.json` 制作 Linux（主推 `.deb`，锁定 `/opt/<slug>` 与 `.desktop`，含 `bubblewrap`/AppArmor 探针）与 macOS（`internalSlug.app` + 4 Helper + `.localized`/`InfoPlist.strings` + 由内向外无 `--deep` ad-hoc 重签 + Quarantine 验收）工具包，并按「默认 opaque-iframe/声明式积木真隔离 + 可选受审 `dsh.client`（禁 `!!js`、明示非沙箱）」双轨接入扩展能力。 | 交付各目标架构原生安装包、分平台锁、验收日志与业务样例结果，界面明确展示每个平台已验证到哪一步。 |

第一项工程任务是用同一份不可变 `base-shell` 和两份手写 `product.json` 跑通经 Staging 纯 JS `resedit` 钤印、`--prepackaged` 封包、能同机并存且能改名覆盖升级与防降级的「青禾投标」与「青禾设计室」安装包。随后选型器、图稿解释和分级预览每推进一步，都能拿真实客户端核对结果。
