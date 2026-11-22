# dsh-self-studio

<p>
  <a href="README.md">简体中文</a> · <b>English</b> · <a href="https://dsh-self.octoooo.com/en/">Website dsh-self.octoooo.com</a>
</p>

**dsh-self Studio (Build My Client)** is a self-contained plugin bundle for official `DeepSeek Harness (dsh@0.2.2-rc.5)`. Inside `dsh web` or official `dsh` Desktop, it turns a natural-language brief and optional design references into an isolated, standalone desktop application with its **own brand icon, isolated data directory, custom home workbench, and pinned plugin lock**.

> **Core Value: Pack once, reuse reliably, distribute directly**  
> - **Pinned `dsh` & plugin versions—immune to breaking upgrades**: Every generated installer seals Electron, Node, the exact `dsh` runtime, and locked plugin versions inside. Future upstream `dsh` or plugin updates will never break an already-built app.  
> - **Ready to distribute**: Share the `.exe` installer directly with teammates, friends, or clients—no Node, no `dsh`, and no plugin setup needed on their machine.  
> - **Fully isolated & intentionally upgradable**: Distinct apps (e.g., Qinghe Bids and Qinghe Design) install side-by-side with isolated icons, workspaces, and data directories, supporting clean rename-upgrades and downgrade protection whenever you choose to rebuild.

---

## Compatibility & Runtime

| Requirement | Details |
|---|---|
| DeepSeek Harness (`engines.dsh`) | `>=0.2.2-rc.1 <0.3.0` (verified with zero unmet requirements and live smoke tests on both official `dsh@0.2.2-rc.1` Desktop and `dsh@0.2.2-rc.5`) |
| Node.js (`engines.node`) | `>=24.9` (baseline `26.12.1`) |
| Host Support | Official `dsh web` and `dsh` Desktop (uses public `ctx.connection`, `ctx.slots`, `ctx.locale`, `ctx.layout`, and `ctx.get('llm')` primitives only) |
| Peer Dependencies | `@deepseek-ai/cordis ~4.1.0`, `react ^18.3.1` (provided by host) |
| Bundle Hygiene | Zero `workspace:*` dependencies in packed output; plain YAML Core Schema `cordis.patch.yml` (no `!!js` tags) |

---

## Installation

> Current version is `0.1.0` (release-prepared). Before public npm / GitHub publication, install directly from the locally packed `.tgz` tarball.

### 1. From Local Tarball (Available Now)

Run the release packer and verifier in the `dsh-self` monorepo, then install:

```bash
node scripts/prepare-plugin-release.mjs --pack
dsh plugin --profile web add /path/to/dsh-self/.dev/plugin-release/dsh-self-studio-0.1.0.tgz
```

### 2. From npm (After Public Release)

```bash
dsh plugin --profile web add dsh-self-studio@0.1.0
```

### 3. Via Official DSH Custom Plugin Index (After Public Release)

Enable **Custom Plugin Index** under **Settings → Plugins → Experimental Plugins**, open **Discover → Add Index Source**, and add:

```text
https://dsh-self.octoooo.com/dsh/index.json
```

Once enabled, click **Build My Client** in the left sidebar to launch the 6-step Studio.

---

## 6-Step Studio Workflow

1. **Requirements**: Describe your client in plain language, optionally expand it using your `dsh` default model (with automatic offline fallback), attach a reference image (distinguishing workbench reference vs. workspace content) or SSRF-guarded reference URL, or import an existing `product.json` to iterate.
2. **Blueprints**: Compare three instant variants (**Lite / Standard / Pro**) with live 1:1 light/dark desktop previews and minimal clarifying questions.
3. **Plugins**: Curated whitelist selection with 4-step static admission, 6-dimension conflict detection, local installed-plugin detection, per-action overrides, and MCP fallback hints when a candidate conflicts with the host runtime.
4. **Appearance**: Customize bilingual display names, semver app version, app icon (4 SVG presets or uploaded PNG/JPG/WebP), 8 semantic color seeds (deterministically deriving 110+ `--dsw-*` variables with WCAG 4.5:1 contrast clamping), 4 closed-set layouts, and module order.
5. **Preview & Tweak**: Launch an isolated child-process preview with live hot-refresh for theme/copy/layout tweaks, conversational natural-language refinement, and one-click revision rollback.
6. **Build & Release**: Build native Windows x64 NSIS installers locally or generate cross-platform recipes (portable transfer bundle, GitHub Actions workflow, Docker/remote script) for Linux `.deb` and macOS `.dmg`, with SHA-256 receipts and persisted release history.

---

## Security & Permissions Disclosure

- **Host Process Scope**: As a standard Host + Client DSH plugin, the host half runs inside the DSH host process with the current OS user's filesystem and network permissions (used to store Studio projects and drive fetch/preview/build child workers).
- **CaMeL Taint Separation**: Visual and webpage extraction splits outputs strictly into `controlSafe` (closed-set layout, widget IDs, capability intents, `#RRGGBB` seeds) and `taintedDisplay` (untrusted display text that never re-enters planning prompts).
- **SSRF-Guarded URL Fetching**: Reference URLs are fetched in an isolated `fetch-worker` child process blocking loopback, RFC1918, link-local / cloud metadata (`169.254.169.254`), CGNAT, NAT64, IPv4-mapped IPv6, and non-`80/443` ports.
- **Privacy Defaults**: Generated clients and preview workers set `DSH_TELEMETRY_DISABLED=1` and disable `session-log-deepseek` in seed configuration.
- **Unsigned Local Builds**: Locally generated Windows installers are unsigned internal/test packages and will trigger Windows SmartScreen warnings if distributed over the internet; commercial code signing and macOS notarization are separate release stages.

---

## Links

- Official Website & Docs: [https://dsh-self.octoooo.com/en/](https://dsh-self.octoooo.com/en/)
- Source Repository: [https://github.com/Octo-o-o-o/dsh-self](https://github.com/Octo-o-o-o/dsh-self)
- License: [PolyForm Noncommercial 1.0.0 + ≤ 20 Internal Users Free + Commercial License](LICENSE) (see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md); contact `octoooo@octoooo.com` for > 20 internal company users or selling/delivering packaged clients commercially)
