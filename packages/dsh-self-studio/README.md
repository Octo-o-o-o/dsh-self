# dsh-self-studio

<p>
  <b>简体中文</b> · <a href="README.en.md">English</a> · <a href="https://dsh-self.octoooo.com/">官网 dsh-self.octoooo.com</a>
</p>

**dsh-self Studio（制作我的客户端）** 是一个面向官方 `DeepSeek Harness (dsh@0.2.2-rc.5)` 的自包含插件包（bundle）。它让你在 `dsh web` 或官方桌面端里，用自然语言、设计参考图或参考网页，一步步生成、1:1 隔离热预览并导出拥有**独立图标、独立数据目录、独立业务首页与锁定插件组合**的专属桌面客户端。

> **核心价值：一次打包好，长期重复使用，直接分发给他人**  
> - **版本双固定，不怕升级失效**：生成的独立客户端将 Electron、Node、`dsh` 宿主版本与全部业务插件版本一并封存在安装包内；后续上游 `dsh` 或插件升级改版，绝不会让已打包好的客户端突然无法使用。  
> - **直接分发，双击即用**：打包好的 `.exe` 等安装包可以直接发给同事、朋友或客户，对方无需安装 `dsh`、Node 或折腾任何插件环境，双击安装即可直达专属业务首页。  
> - **多开隔离，可随时主动升级**：不同客户端（如「青禾投标」「青禾设计室」）各自拥有独立图标、数据目录与工作区，同机并存零干扰，支持改名覆盖升级与防降级保护。

---

## 兼容性与运行环境

| 项 | 要求 |
|---|---|
| DeepSeek Harness (`engines.dsh`) | `>=0.2.2-rc.1 <0.3.0`（已在官方 `dsh@0.2.2-rc.1` 桌面端与 `dsh@0.2.2-rc.5` 双版本通过 `evaluatePluginCompatibility` 零缺口校验与实机冒烟） |
| Node.js (`engines.node`) | `>=24.9`（基线 `26.12.1`） |
| 宿主支持 | `dsh web` 与官方 `dsh` 桌面端（仅使用公开 `ctx.connection` / `ctx.slots` / `ctx.locale` / `ctx.layout` / `ctx.get('llm')` 原语，零私有宿主耦合） |
| Peer 依赖 | `@deepseek-ai/cordis ~4.1.0`、`react ^18.3.1`（均由宿主共享提供） |
| Bundle 依赖 | 自包含产物零 `workspace:*` 依赖，`cordis.patch.yml` 仅使用纯 YAML Core Schema（无 `!!js` 标签） |

---

## 安装方式

> 当前版本为 `0.1.0` 发布准备版。若尚未公开发布到 npm / GitHub，推荐直接安装本地构建生成的 `.tgz` 包。

### 1. 从本地构建产物安装（当前可用）

在 `dsh-self` 源码仓库执行发布打包与校验后安装：

```bash
node scripts/prepare-plugin-release.mjs --pack
dsh plugin --profile web add /path/to/dsh-self/.dev/plugin-release/dsh-self-studio-0.1.0.tgz
```

### 2. 从 npm 安装（发布至 npm 后）

```bash
dsh plugin --profile web add dsh-self-studio@0.1.0
```

### 3. 从自定义插件索引安装（发布至 npm / GitHub 后）

在 DSH **设置 → 插件 → 实验性插件** 开启「自定义插件索引」，进入 **发现 → 添加索引源**，填入：

```text
https://dsh-self.octoooo.com/dsh/index.json
```

安装后在左侧边栏点击 **制作我的客户端** 图标即可进入 6 步工作台。

---

## 6 步制作流程

1. **写需求（Requirements）**：输入一句话需求，或点「先帮我生成完整需求」借助 `dsh` 默认模型（未配置模型时自动离线补全）展开为可编辑草稿；支持上传参考图（区分「参考配色布局」与「放进工作区处理」）、安全读取参考网址，或导入既有 `product.json` 开启二次迭代。
2. **选方案（Blueprints）**：自动生成 **极简版 / 标准版 / 专业全功能版** 三套方案，支持即时 1:1 浅色/深色界面预览与最少追问（如区分「仅处理手头标书」与「查询公开标讯」）。
3. **选插件（Plugins）**：基于白名单目录执行四步静态准入与六维冲突检测，自动扫描并标注本机已装 DSH 插件，支持按能力切换替代插件，遇到版本不兼容时直接给出原因与标准 MCP 替代指引。
4. **改外观（Appearance）**：编辑中英文名称、版本号、图标（4 套 SVG 预设或上传 PNG/JPG/WebP）、8 项语义种子色（自动派生 110+ `--dsw-*` 变量并钳制 WCAG 4.5:1 对比度）、4 种布局骨架与首页模块顺序。
5. **试用微调（Preview & Tweak）**：以独立子进程与隔离 Session 分区启动 1:1 实时预览，配色/文案/布局修改秒级热刷新；支持右侧自然语言对话微调与任意历史修订一键回退。
6. **生成安装包（Build & Release）**：支持多平台勾选（本机直打 Windows x64 NSIS `.exe`，跨平台支持导出便携迁移包、GitHub Actions 云打包配置或 Docker/远程机脚本），附带 SHA-256 校验码与持久化版本历史管理。

---

## 安全与权限披露

- **Host 进程权限**：作为标准 DSH Host + Client 插件，`dsh-self-studio` 的 Host 部分运行于 DSH 宿主进程内，拥有当前操作系统用户的文件读写与网络访问权限（用于保存项目配置、运行抓取/预览/构建子进程）。
- **CaMeL 污点分离**：外部设计图与参考网页抽取结果严格拆分为 `controlSafe`（闭集布局、模块、意图与 `#RRGGBB` 种子色）与 `taintedDisplay`（不可信展示文本，绝不回流规划模型）。
- **双层防 SSRF 抓取**：参考网址在独立 `fetch-worker` 子进程中执行，拦截回环、RFC1918 私网、链路本地（含云元数据 `169.254.169.254`）、CGNAT、NAT64、IPv4-mapped IPv6 与非 `80/443` 端口。
- **预览隔离**：预览子进程使用独立端口与数据目录，并在成品与预览层关闭默认遥测（`DSH_TELEMETRY_DISABLED=1`、`session-log-deepseek: false`）。
- **未签名内测提示**：本机直接打出的 Windows NSIS 安装包默认未附加商业代码签名证书，经网络分发时会触发系统 SmartScreen 提示；商业签名与 macOS 公证另设独立发布阶段。

---

## 相关链接

- 官网与文档：[https://dsh-self.octoooo.com/](https://dsh-self.octoooo.com/)
- 源码仓库：[https://github.com/Octo-o-o-o/dsh-self](https://github.com/Octo-o-o-o/dsh-self)
- 许可证：[PolyForm Noncommercial 1.0.0 + ≤ 20 人公司内部免费 + 商业授权](LICENSE)（详见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)，超 20 人企业内部使用或打包对外售卖/定制交付请联系 `octoooo@octoooo.com`）
