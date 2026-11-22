<h1 align="center">dsh-self</h1>

<p align="center">
  <b>把你的 DeepSeek Harness 工作流，打包成独立桌面客户端。</b><br>
  一次打包好，长期重复使用 · <code>dsh</code> 与插件版本双固定，不因升级失效 · 安装包可直接分发给他人双击即用
</p>

<p align="center">
  <a href="https://dsh-self.octoooo.com/"><img alt="Website" src="https://img.shields.io/badge/website-dsh--self.octoooo.com-0f766e" /></a>
  <a href="LICENSE"><img alt="License: PolyForm Noncommercial + Commercial" src="https://img.shields.io/badge/license-PolyForm--NC%20%2B%20Commercial-2563eb.svg" /></a>
  <img alt="DSH Target" src="https://img.shields.io/badge/dsh-0.2.2--rc.1%20~%200.2.2--rc.5-0d9488" />
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D24.9-339933" />
  <img alt="Tests" src="https://img.shields.io/badge/unit%20%26%20contract-32%20passed-16a34a" />
  <img alt="Win E2E" src="https://img.shields.io/badge/Windows%20E2E-5%20NSIS%20installers%20verified-16a34a" />
</p>

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a> · <a href="https://dsh-self.octoooo.com/">官网</a> · <a href="https://dsh-self.octoooo.com/guide">使用指南</a> · <a href="docs/RELEASING.md">插件发布准备</a>
</p>

---

```text
一句话需求 / 参考图 / 参考网页 / product.json
        │
        ▼
  dsh-self-studio（官方 dsh@0.2.2-rc.5 标准自包含插件）
  ├── 1. 写需求（dsh 默认模型扩写 + 离线兜底 + CaMeL 污点分离）
  ├── 2. 选方案（极简 / 标准 / 专业三套 1:1 实时方案对比）
  ├── 3. 选插件（白名单目录 · 四步准入 · 六维冲突检测 · MCP 替代指引）
  ├── 4. 改外观（不可变系统身份 + 可变中英品牌/图标/8 种子色/布局模块）
  ├── 5. 试用微调（独立子进程隔离热预览 + 自然语言微调 + 修订回退）
  └── 6. 生成安装包（独立信任根 tools/builder · 三步预打包 · SHA-256 回执）
        │
        ▼
  独立桌面软件（如「青禾投标」「青禾设计室」）
  ├── 独立系统身份（productId / internalSlug / nsisGuid / AppUserModelID）
  ├── 独立数据目录（<userData>/h/profiles/p-<seedHash> 双槽自愈 + 防降级）
  ├── 独立工作区（~/Workspaces/<internalSlug>）与纯净首启（零遥测、零登录弹窗）
  └── 同机并存、同名消歧、改名覆盖升级与脱敏诊断包导出
```

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [当前状态与验证边界](#当前状态与验证边界)
- [快速开始](#快速开始)
- [6 步制作体验](#6-步制作体验)
- [安全与工程架构](#安全与工程架构)
- [工程结构](#工程结构)
- [CLI 独立打包器](#cli-独立打包器)
- [发布 dsh-self-studio 插件](#发布-dsh-self-studio-插件)
- [开发与测试](#开发与测试)
- [上游来源与参考文档](#上游来源与参考文档)
- [许可证](#许可证)

---

## 它解决什么问题

**一次打包好，版本固定、长期复用、直接分发给他人。**

把「万能工具箱」拆成「专用小家电」——生成出来的不是依赖外部环境的薄壳，而是**内置固定版本 Electron、Node、`dsh` 宿主与锁定业务插件的独立桌面软件**：

- **一次打包好，后续长期重复使用**：配好并打出安装包后，即使退出 `dsh`、断网离线或换一台电脑，已打包客户端都能稳定反复打开使用。
- **`dsh` 版本与插件版本双固定，不会因升级无法使用**：运行时版本（如 `dsh@0.2.2-rc.5`）与全部插件精确版本、完整性哈希、依赖树一并封存进安装包；上游 `dsh` 或社区插件后续升级改版、甚至接口破坏性变化，都不会影响你已经打好的客户端——需要升级时再主动回 Studio 重打覆盖即可。
- **直接分发给其他人使用，双击即用**：直接把 `.exe` 等安装包发给同事、朋友或客户，对方**不需要装 Node、不需要装 `dsh`、也不需要折腾插件与配置**，双击安装即可打开专属业务首页。

| 场景 | 在单个 `dsh` 里混装插件 | 用 `dsh-self` 生成独立客户端 |
|---|---|---|
| 长期稳定复用 | 上游 `dsh` 或插件升级容易导致原本好用的流程突然报错 | **版本双固定**：`dsh` 与插件锁死在安装包内，绝不因外部升级失效 |
| 分发给同事或客户 | 要先教对方装 Node / `dsh`、选插件、配环境 | **直接分发安装包**：双击即装即用，零环境准备 |
| 多业务并行（投标 / 设计 / 法务） | 菜单、聊天记录、工作区文件全混在一个窗口 | 各自独立图标、独立窗口、独立工作区与数据目录，同机多开互不串台 |
| 二次迭代与主动升级 | 手工同步配置，容易串台或降级破坏数据 | 导出/重导 `product.json` 主动重打，不可变身份保证改名升级不断档、旧版自动拦截 |

---

## 当前状态与验证边界

本项目如实区分**已实现并验证**与**待外部发布/后续阶段**的能力：

| 维度 | 当前状态 | 说明 |
|---|---|---|
| `dsh-self-studio` 官方插件包 | **发布就绪（v0.1.0）** | 自包含产物零 `workspace:*`，显式声明 `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`，在官方 `dsh@0.2.2-rc.1` 桌面端与 `dsh@0.2.2-rc.5` 双版本下通过 `evaluatePluginCompatibility`（0 缺口）、实机 RPC/子进程预览冒烟、Track A 门禁与 10 项插件发布校验 |
| 单元与上游契约测试 | **32 / 32 通过** | 8 个测试文件覆盖 `product-spec`、白名单目录与 13 项 peer 冲突拦截、OOXML 安全/沙箱预览、`sharp` 超长图批注、SSRF 拦截、6 步 Studio 生命周期、Electron 宿主 `ELECTRON_RUN_AS_NODE` 子进程适配、双槽回滚、脱敏诊断、NSIS 宏与 Linux/macOS Stager |
| Windows x64 独立安装包（NSIS） | **真机 5 包实测全过** | 不可变 `base-shell`（Node 26.12.1 + Electron 44.11.5 + 去重 `dsh@0.2.2-rc.5`）+ Electron Fuses + 纯 JS `resedit` PE 钤印 + `--prepackaged` 封包；`scripts/verify-win-e2e.mjs` 已在 Windows 11 真机跑通全部 5 份 NSIS `.exe` 安装包：静默安装与 Fuses 核验、冷启 `/api/product-spec` HTTP 200 且无孤儿 Host、双产品同机并存、同名快捷方式消歧、改名升级（稳定端口保持 + 双槽切换 + 打包态脱敏诊断包 0 泄漏）、NSIS 降级拦截（退出码 `1638`）与单边卸载清理 |
| Linux `.deb` / macOS `.dmg` | **Stager 与跨平台配方就绪** | Studio 支持导出便携迁移包、GitHub Actions 云打包配置与 Docker/远程机脚本；`/opt/<slug>`、ASCII `.app` 与由内向外重签顺序已通过单测，原生宿主实机安装验收另行推进 |
| 商业代码签名与公开分发 | **后续阶段** | 本机产出默认标记为 `unsigned-local-test`（无商业证书，经网络传输会触发 SmartScreen/Gatekeeper 提示）；npm / GitHub / `dsh.pub` 公开发布需由维护者按 [docs/RELEASING.md](docs/RELEASING.md) 执行 |

---

## 快速开始

### 环境要求

- **Node.js** `>= 24.9`（基线 `26.12.1`）
- **pnpm** `11.28.5`（开发依赖安装，可用 `npx --yes pnpm@11.28.5`）
- **官方 DeepSeek Harness** `>= 0.2.2-rc.1 < 0.3.0`（已在官方桌面端 `0.2.2-rc.1` 与 `0.2.2-rc.5` 实机验收；生成的独立客户端内置锁定 `dsh@0.2.2-rc.5`）

### 方式一：将 `dsh-self-studio` 安装到官方 `dsh@0.2.2-rc.5`

```bash
# 1. 构建并运行 10 项插件发布门禁，生成自包含 .tgz 安装包
node scripts/prepare-plugin-release.mjs --pack

# 2. 安装到你的官方 dsh profile（web 或 desktop）
dsh plugin --profile web add .dev/plugin-release/dsh-self-studio-0.1.0.tgz

# 3. 启动官方 dsh web，在左侧栏点击「制作我的客户端」
dsh web
```

> 发布到 npm 后可直接运行 `dsh plugin --profile web add dsh-self-studio@0.1.0`，或在 DSH **设置 → 插件 → 发现** 添加自定义插件索引：`https://dsh-self.octoooo.com/dsh/index.json`。

### 方式二：在仓库内一键启动官方 `dsh web` 隔离演示

```bash
npm run build
node scripts/launch-official-dsh-demo.mjs
```

该脚本会把自包含的 `dsh-self-studio` 装入 `.dev/official-dsh-demo/dsh-home` 隔离 profile 并启动官方 `dsh@0.2.2-rc.5 web`（默认 `http://127.0.0.1:14567`），终端会打印带 token 的直达链接。

---

## 6 步制作体验

1. **写需求**：输入一句话想法（内置「青禾投标」「青禾设计室」「法务合同审查」「查标讯冲突演示」四套灵感示例），支持一键用 `dsh` 默认模型扩写完整需求（离线自动兜底），可选上传参考图、SSRF 防护读取参考网址，或导入已有 `product.json` 二次迭代。
2. **选方案**：生成 **极简版 / 标准版 / 专业全功能版** 三套蓝图，点卡片即可切换浅色/深色 1:1 窗口预览；仅在影响工作流时最少追问。
3. **选插件**：基于受控白名单目录执行四步静态准入与六维冲突检查（`entryIds`、`httpRoutes`、`panelIds`、`exclusiveSlots`、快捷键、服务名），自动标注本机已装 DSH 插件，支持按动作切换候选并在版本冲突时给出标准 MCP 替代建议。
4. **改外观**：自定义中英文名称、语义化版本号、图标（4 套 SVG 预设或上传 PNG/JPG/WebP）、8 项语义种子色（纯函数派生 110+ `--dsw-*` 变量并强制 WCAG 4.5:1 对比度）、4 种闭集骨架（`single-column` / `list-detail` / `three-pane` / `dashboard-grid`）及首页模块增删排序。
5. **试用微调**：启动独立子进程隔离预览，支持桌面/窄屏宽度切换、秒级热刷新、右侧自然语言对话微调与任意历史修订一键回退。
6. **生成安装包**：勾选目标平台并管理发布版本号与更新说明，产出带 SHA-256 的安装包或跨平台构建配方，并归档至持久化版本管理列表（支持下载产物、导出该版 `product.json`、回退重打与清理）。

---

## 安全与工程架构

- **不可变身份与可变品牌分离**：创建项目时一次性派生并冻结 `productId`、`internalSlug`（最长 21 字符）、`appId`、`appUserModelId`、`nsisGuid`、`executableName`、`userDataDirName`。显示名称、图标、主题和布局可随修订演进，跨 GUID 同名自动追加 `(<shortId>)` 消歧，改名升级自动清理旧 `.lnk` 并覆写 `$launchLink`。
- **CaMeL 双通道污点隔离**：视觉/网页结构提取严格拆分为 `controlSafe`（闭集布局、组件、意图与 `#RRGGBB` 种子色）与 `taintedDisplay`（外部展示文案，绝不回流规划 LLM）。
- **双层 SSRF 防护**：参考网址抓取由独立 `fetch-worker` 子进程完成，仅放行 `http/https` 与 `80/443` 端口，拦截回环、RFC1918 私网、链路本地/云元数据（`169.254.169.254`）、CGNAT（`100.64.0.0/10`）、NAT64、ULA 及 IPv4-mapped IPv6。
- **业务适配器安全边界**：
  - **投标 DOCX (`bid-docx`)**：ZIP 炸弹四重配额、禁 XXE、剥离 `w:altChunk`/外部关系/UNC 路径，拦截扫描件、加密文档与旧 `.doc`；前端通过按需加载的懒加载 chunk（`client.docx-viewer.js`）经 DOMPurify 清洗后渲染于 opaque-origin `<iframe sandbox="allow-scripts" srcdoc>` + 严格 CSP。
  - **设计画布 (`design-canvas`)**：自动归一化 EXIF 方向（5–8 交换有效宽高），以限边代理图规避 Chromium `16,384 px` 纹理上限，导出时采用逐标注小块纯几何 SVG 经 `sharp.composite` 合成 PNG，规避 Cairo `32,767 px` 硬上限（实测覆盖 `2000×40000` 超长图）。
- **三步预打包、Electron Fuses 与双槽自愈**：只读 `base-shell` 预固化安全 Electron Fuses（`RunAsNode: false`、`OnlyLoadAppFromAsar: true`、`EnableNodeOptionsEnvironmentVariable: false` 等）；Staging 阶段纯 JS `resedit` 钤印后由 `electron-builder --prepackaged` 仅封安装器；运行期 `<userData>/h/profiles/p-<seedHash>` 双槽换槽，连续 2 次冷启失败自动回退上一健康槽，并在 NSIS `customInit` 与运行期 `state-version.json` 双重阻断降级覆盖。
- **隐私默认与脱敏诊断**：种子层关闭 `session-log-deepseek` 与 `plugin-package-inventory-deepseek`、默认注入 `DSH_TELEMETRY_DISABLED=1`、子进程采用最小环境变量白名单（剥离 `NODE_OPTIONS` / 外部模型密钥，保留企业代理与根证书），支持导出物理排除 `.credentials.yaml` 与 `.env*` 的脱敏诊断压缩包。

---

## 工程结构

```text
dsh-self/
├── packages/
│   ├── product-spec/      # Zod Schema、A2UI 闭集组件/动作注册表、不可变身份与主题派生
│   ├── catalog/           # 白名单目录、四步静态准入、六维冲突检测与分平台锁生成
│   ├── adapters/          # bid-docx（OOXML 安全解析/导出）与 design-canvas（EXIF/超长图批注）
│   └── dsh-self-studio/   # 官方 dsh@0.2.2-rc.5 自包含插件（Host + React 18 UI + Workers + Skill + Icon/Locale）
├── templates/
│   └── desktop/           # Electron 桌面壳、双槽自愈、最小环境白名单、自有主题/壳插件
├── tools/
│   ├── dsh-client-build/  # 支持独立懒加载异步 chunk 的 DSH 客户端打包器
│   └── builder/           # 独立信任根 CLI、base-shell Fuses、NSIS 宏与 Win/Linux/macOS Stager
├── scripts/
│   ├── build.mjs                  # 全仓构建
│   ├── pack-studio-bundle.mjs     # 打包自包含 dsh-self-studio bundle
│   ├── prepare-plugin-release.mjs # DSH 插件 10 项发布门禁校验、打包与 dist 仓库同步
│   ├── assemble-base-shell.mjs    # 装配只读 base-shell（含 Electron Fuses）
│   ├── launch-official-dsh-demo.mjs # 官方 dsh@0.2.2-rc.5 web 隔离演示启动器
│   └── verify-win-e2e.mjs         # Windows 真实 5 包 E2E 安装/并存/升级/防降级验收
├── fixtures/              # 青禾投标、青禾设计室、改名升级、降级拦截与安全回归夹具
├── tests/                 # 单元测试（7 组）与上游 dsh@0.2.2-rc.5 契约测试（1 组）
├── website/               # 双语官网源码（部署于 https://dsh-self.octoooo.com/）
└── docs/                  # 实施方案、参考核验记录与插件发布指南
```

---

## CLI 独立打包器

`tools/builder` 可脱离制作器界面，直接以 `product.json` 与对应平台锁构建独立客户端：

```bash
npm run build
npm run assemble:base-shell

node tools/builder/dist/cli.js \
  --product fixtures/qinghe-bids/product.json \
  --lock fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json \
  --target win32-x64 \
  --base-shell .dev/base-shell/win32-x64 \
  --out .dev/out/qinghe-bids
```

输出目录将生成安装包、`build-receipt.json`（含产品摘要、锁摘要、`seedHash`、安装包 SHA-256）及分发状态标识。

---

## 发布 `dsh-self-studio` 插件

已为官方 DSH 插件生态准备好完整发布流水线与 10 项自动化门禁，详见 [docs/RELEASING.md](docs/RELEASING.md)：

```bash
# 运行 10 项发布校验并生成 .dev/plugin-release/dsh-self-studio-0.1.0.tgz 与 SHA256SUMS.txt
node scripts/prepare-plugin-release.mjs --pack

# 仅执行只读校验（检查已打包的 release 目录）
node scripts/prepare-plugin-release.mjs --check

# 同步到独立的公开 Git 分发仓库目录（供 GitHub 安装 / dsh.pub / dsh.so 收录）
node scripts/prepare-plugin-release.mjs --sync-dist ../dsh-self-studio
```

---

## 开发与测试

```bash
# 构建全仓（含核心库、桌面模板、builder 与自包含 studio bundle）
npm run build

# TypeScript 类型检查
npm run typecheck

# 单元测试（30 项）与上游契约测试（2 项）
npm test
npm run test:contract

# 全量测试（32 项）
npx vitest run

# 官网构建与静态/Worker 自动化测试
npm --prefix website test

# Windows x64 真实安装包 E2E 验收（需先执行 npm run assemble:base-shell）
node scripts/verify-win-e2e.mjs
```

---

## 上游来源与参考文档

- [官网（dsh-self.octoooo.com）](https://dsh-self.octoooo.com/) · [在线指南](https://dsh-self.octoooo.com/guide)
- [专属桌面客户端生成器实施方案](docs/implementation-plan.md)
- [参考项目与底层核验依据](docs/references.md)
- [DSH 插件发布准备与渠道清单](docs/RELEASING.md)
- [上游源码基线声明](UPSTREAM_SOURCE.md)（桌面壳模板基线来自 `Octo-o-o-o/OctoDeepSeek`，宿主固定为 `deepseek-ai/deepseek-harness@dsh-v0.2.2-rc.5`）

本项目为独立开源项目，与 DeepSeek 官方无隶属关系。

---

## 许可证与商业授权

本项目采用 **PolyForm Noncommercial License 1.0.0 + 20 人以内公司内部免费附加许可 + 商业授权** 双重许可模式（详见 [LICENSE](LICENSE)、[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

- **个人与非商业使用**：免费（个人自用、免费无门槛社区分享、学术研究、非营利机构）。
- **公司内部自用（总计 ≤ 20 人）**：**免费，无需联系授权**（仅限公司内部自用，不得对外售卖或收费交付给外部客户）。
- **公司内部使用超过 20 人（> 20 人）**，或**打包独立客户端对外售卖 / 订阅 / 外包收费交付 / 白标去署名**：须事先联系作者获取书面商业授权，请联系 [`octoooo@octoooo.com`](mailto:octoooo@octoooo.com)。
- 若打包客户端时引入了第三方社区 DSH 插件，该社区插件另行遵守其原作者协议。
