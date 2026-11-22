# dsh-self-studio 插件发布准备与渠道指南

更新时间：2026-11-22。本文说明如何将 `packages/dsh-self-studio` 验证、打包并发布到 **npm**、**独立 GitHub 分发仓库**、**官方 DSH 自定义插件索引**（`https://dsh-self.octoooo.com/dsh/index.json`）以及 **dsh.pub / dsh.so** 等社区目录。

---

## 一句话原则

**源码只在当前 `dsh-self` monorepo 修改；发布产物与独立分发仓库均由脚本自动生成并经 10 项门禁校验，切勿手改生成后的 `dist/`、`lib/` 或分发仓库的 `package.json`。**

---

## 1. 一键打包与 10 项发布门禁校验

在仓库根目录执行：

```bash
node scripts/prepare-plugin-release.mjs --pack
```

该脚本会自动完成：
1. 打包 `dsh-self-studio` 的 Host 入口、独立子进程 worker（`fetch-worker.js`、`preview-worker.js`）与 React 18 lazy-CJS 客户端（`lib/client.js`）；
2. 写入完整发布级 `package.json`（`private: false`、零 `workspace:*`、`icon`、`keywords`、`exports`、`files`、`engines.dsh`、`dsh.manifestVersion: 1`、`publishConfig`）；
3. 注入 `icon.svg`、`locale/zh.json`、`locale/en.json`、`skills/client-maker/SKILL.md`、`cordis.patch.yml`、`README.md`、`README.en.md`、`LICENSE`、`COMMERCIAL-LICENSE.md` 与 `THIRD_PARTY_NOTICES.md`；
4. 打出标准 npm 安装包 `.dev/plugin-release/dsh-self-studio-<version>.tgz` 并写出 `SHA256SUMS.txt` 与 `release-report.json`；
5. 依次运行 **10 项强制发布门禁**：

| # | 门禁项 | 校验内容 |
|---|---|---|
| 1 | `dsh-compat` | 调用官方 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 核验 `dsh@0.2.2-rc.5` 零缺口，并校验 `engines.dsh` / `engines.node` / `cordis` & `react` peers |
| 2 | `track-a-creator-gate` | 通过 `verifyTrackAOfficialStudioBundle`（零 `workspace:*`、零 OctoDeEpSeeK 私有 API、独立 worker 就位） |
| 3 | `cordis-patch-yaml` | `cordis.patch.yml` 仅允许纯 YAML Core Schema，禁用 `!!js` 标签与 YAML 别名炸弹 |
| 4 | `client-bundle-factory` | `lib/client.js` 包含 `window.__ModuleLoader__.load`、精确 `id: "dsh-self-studio"` 与 `var module = { exports: {} }` 三段式包装 |
| 5 | `host-and-workers-syntax` | 对 `dist/index.js`、`dist/workers/fetch-worker.js`、`dist/workers/preview-worker.js` 执行 `node --check` 并确认零 `workspace:` 引用 |
| 6 | `manifest-publish-metadata` | 校验 `private: false`、`icon`、`keywords`（含 `dsh-plugin`/`deepseek-harness`/`dsh`）、`homepage`、`repository`、`bugs`、`license`、`exports` 与 `files` 白名单 |
| 7 | `assets-and-docs` | 校验 `icon.svg`（合法 SVG 且 `<= 32 KiB`）、`locale/{zh,en}.json`、`skills/client-maker/SKILL.md`、双语 README 与 `LICENSE` |
| 8 | `tarball-clean-audit` | 扫描 `.tgz` 条目，确认零 `.env*`、`.npmrc`、`*.pem`/`*.key`、`node_modules/`、`.git/`、`src/` 或测试文件，且路径均合法 |
| 9 | `host-apply-smoke` | 动态 `import()` 打包后的 `dist/index.js`，断言 `name === 'dsh-self-studio'`、`inject` 含 `connection`，模拟 `apply(ctx)` 注册 `/api/dshSelfStudio` 与全部导出路由并干净释放 |
| 10 | `market-index-valid` | 校验 `website/src/dsh/index.json` 符合官方 DSH 自定义插件索引 `format: 1` 规范 |

只读复核已有产物：

```bash
node scripts/prepare-plugin-release.mjs --check
```

---

## 2. 本机真实 `dsh@0.2.2-rc.5` 安装冒烟

发布到公网前，建议用打包出的 `.tgz` 直接在干净 profile 验证：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-self/.dev/plugin-release/dsh-self-studio-0.1.0.tgz
dsh web
```

确认：
- **设置 → 插件** 中显示 `dsh-self-studio`（带矢量图标与中文/英文名称、版本 `0.1.0`、零兼容警告）；
- 左侧边栏出现 **制作我的客户端** 图标，点击后 6 步流程与预览/构建接口均可正常响应。

---

## 3. 发布到 npm（`dsh-self-studio`）

1. 确认已登录 npm 且具备发布权限：
   ```bash
   npm whoami
   ```
   若返回 `401`，先执行 `npm login`。
2. 先演练确认打包清单无误：
   ```bash
   npm pack --dry-run .dev/plugin-release/dsh-self-studio
   ```
3. 从校验通过的独立目录发布（不要在包含 `workspace:*` 的 `packages/dsh-self-studio` 目录直接发布！）：
   ```bash
   npm publish .dev/plugin-release/dsh-self-studio --access public
   ```
4. 发布后核验：
   ```bash
   npm view dsh-self-studio version dist.integrity
   ```
   > 提示：pnpm 默认开启 `minimumReleaseAge` 冷却期，刚发布的版本安装时建议显式指定版本号 `dsh plugin --profile web add dsh-self-studio@0.1.0`。

---

## 4. 发布到独立 GitHub 分发仓库（供 `github:` 安装、`dsh.pub` 与 `dsh.so` 收录）

由于本仓库为 monorepo，`packages/dsh-self-studio` 在开发态含 `workspace:*` 依赖且 `dist/` 默认被 `.gitignore` 忽略；为满足 `dsh plugin add github:...` 与 `dsh.pub` 根目录 bundle 契约，推荐同步到独立公开分发仓库（如 `Octo-o-o-o/dsh-self-studio`）：

```bash
# 1. 生成/刷新分发仓库内容（保留目标目录 .git，仅替换生成文件）
node scripts/prepare-plugin-release.mjs --sync-dist ../dsh-self-studio

# 2. 检查变更并提交、打 tag
git -C ../dsh-self-studio status
git -C ../dsh-self-studio add -A
git -C ../dsh-self-studio commit -m "release: dsh-self-studio 0.1.0"
git -C ../dsh-self-studio push origin main
git -C ../dsh-self-studio tag v0.1.0
git -C ../dsh-self-studio push origin v0.1.0

# 3. 创建 GitHub Release 并附带校验和与 .tgz
gh release create v0.1.0 \
  --repo Octo-o-o-o/dsh-self-studio \
  --title "dsh-self-studio 0.1.0" \
  .dev/plugin-release/dsh-self-studio-0.1.0.tgz \
  .dev/plugin-release/SHA256SUMS.txt
```

在 GitHub 仓库设置中添加 topic `dsh-plugin`（供 `dsh.pub` 自动索引），主页设为 `https://dsh-self.octoooo.com/`。

---

## 5. 更新官网与官方 DSH 自定义插件索引

官网源码位于 `website/`，部署在 Cloudflare Workers Static Assets（`dsh-self-site`），绑定域名 `https://dsh-self.octoooo.com/`：

- 自定义插件索引文件：`website/src/dsh/index.json`（公网地址 `https://dsh-self.octoooo.com/dsh/index.json`）
- 索引图标：`website/src/dsh/icons/dsh-self-studio.svg`

每次版本更新后：
1. 更新 `website/src/dsh/index.json` 的 `versions`（版本号、Unix 秒 `publishTimestamp`、`source` 与 `engines.dsh`）以及页面中的发布状态说明；
2. 本地验证并部署：
   ```bash
   npm --prefix website test
   npx --prefix website wrangler deploy
   ```

---

## 6. 社区目录收录清单

完成 npm 与公开 Git 分发仓库推送后，按各渠道规则分别提交（不要由 Git 发版推定市场已自动更新）：

| 渠道 | 入口 | 方式 |
|---|---|---|
| **官方 DSH 自定义插件索引** | `https://dsh-self.octoooo.com/dsh/index.json` | 随官网部署自动生效 |
| **dsh.pub** | `https://dsh.pub/zh/submit/` | 提交公开分发仓库 `https://github.com/Octo-o-o-o/dsh-self-studio`（并加 `dsh-plugin` topic） |
| **dsh.so** | `https://www.dsh.so/zh/submit/` | 提交 npm 包名 `dsh-self-studio` 或公开分发仓库 URL |
