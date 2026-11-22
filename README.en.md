<h1 align="center">dsh-self</h1>

<p align="center">
  <b>Turn any DeepSeek Harness workflow into an isolated, standalone desktop client.</b><br>
  Pack once, reuse reliably · Pinned <code>dsh</code> &amp; plugin versions immune to breaking upgrades · Share installers directly with others
</p>

<p align="center">
  <a href="https://dsh-self.octoooo.com/en/"><img alt="Website" src="https://img.shields.io/badge/website-dsh--self.octoooo.com-0f766e" /></a>
  <a href="LICENSE"><img alt="License: PolyForm Noncommercial + Commercial" src="https://img.shields.io/badge/license-PolyForm--NC%20%2B%20Commercial-2563eb.svg" /></a>
  <img alt="DSH Target" src="https://img.shields.io/badge/dsh-0.2.2--rc.1%20~%200.2.2--rc.5-0d9488" />
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D24.9-339933" />
  <img alt="Tests" src="https://img.shields.io/badge/unit%20%26%20contract-32%20passed-16a34a" />
  <img alt="Win E2E" src="https://img.shields.io/badge/Windows%20E2E-5%20NSIS%20installers%20verified-16a34a" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b> · <a href="https://dsh-self.octoooo.com/en/">Website</a> · <a href="https://dsh-self.octoooo.com/en/guide">Guide</a> · <a href="docs/RELEASING.md">Plugin Release Prep</a>
</p>

---

```text
One-sentence brief / reference image / reference URL / product.json
        │
        ▼
  dsh-self-studio (self-contained official dsh@0.2.2-rc.5 bundle)
  ├── 1. Requirements  (dsh default-model expansion + offline fallback + CaMeL taint split)
  ├── 2. Blueprints    (Lite / Standard / Pro instant 1:1 desktop comparisons)
  ├── 3. Plugins       (whitelist catalog · 4-step admission · 6-dim conflict checks · MCP fallbacks)
  ├── 4. Appearance    (immutable OS identity + mutable brand/icon/8 theme seeds/layout modules)
  ├── 5. Preview       (isolated child-process hot preview + NL refinement + revision rollback)
  └── 6. Build         (independent trust-root tools/builder · 3-step prepackaged pipeline · SHA-256 receipts)
        │
        ▼
  Standalone Desktop Applications (e.g. Qinghe Bids, Qinghe Design)
  ├── Frozen OS identity (productId / internalSlug / nsisGuid / AppUserModelID)
  ├── Isolated data directory (<userData>/h/profiles/p-<seedHash> dual-slot rollback + downgrade block)
  ├── Dedicated workspace (~/Workspaces/<internalSlug>) & clean first launch (telemetry off, no login popups)
  └── Coexistence, same-name disambiguation, rename upgrades & redacted diagnostics export
```

---

## Contents

- [Why dsh-self](#why-dsh-self)
- [Current Status & Verification Scope](#current-status--verification-scope)
- [Quick Start](#quick-start)
- [6-Step Studio Workflow](#6-step-studio-workflow)
- [Architecture & Security Boundaries](#architecture--security-boundaries)
- [Repository Layout](#repository-layout)
- [Standalone CLI Builder](#standalone-cli-builder)
- [Publishing the dsh-self-studio Plugin](#publishing-the-dsh-self-studio-plugin)
- [Development & Testing](#development--testing)
- [Upstream Provenance & Docs](#upstream-provenance--docs)
- [License](#license)

---

## Why dsh-self

**Pack once, freeze versions, reuse forever, and share with anyone.**

Split a crowded universal toolbox into dedicated appliances—each output is not a fragile shortcut, but a **self-contained desktop application with fixed Electron, Node, `dsh` runtime, and pinned plugins sealed inside**:

- **Pack once, reuse reliably**: Build a client once and keep using it day after day—even offline, after closing Studio, or on another machine.
- **Pinned `dsh` & plugin versions—immune to breaking upgrades**: Both the exact `dsh` runtime (`0.2.2-rc.5`) and every plugin version, hash, and lockfile are frozen inside the installer. Future upstream `dsh` releases or breaking plugin changes will never break an already-packaged app; you only upgrade when you intentionally rebuild.
- **Distribute directly to others—double-click to run**: Hand the `.exe` installer to teammates, friends, or clients. Recipients need **no Node, no `dsh` CLI, and no plugin setup**—just double-click to install and launch straight into the custom workbench.

| Need | Mixing plugins inside one `dsh` window | Packaging with `dsh-self` |
|---|---|---|
| Long-term stability | Upstream `dsh` or plugin updates can silently break a working flow | **Frozen versions**: `dsh` runtime and plugins stay locked inside the app—immune to external upgrades |
| Sharing with others | Recipients must install Node / `dsh`, hunt for plugins, and configure settings | **Direct redistribution**: send a single `.exe` installer—double-click and start working |
| Separating workflows | Menus, chats, credentials, and files collide in one shared window | Distinct desktop icons, windows, workspaces, and isolated `userData` dirs running side-by-side |
| Controlled upgrades | Manual config sync risks drift or downgrading newer user data | Export/re-import `product.json` to rebuild intentionally; frozen OS identity enables clean rename-upgrades and downgrade guards |

---

## Current Status & Verification Scope

We distinguish clearly between what is **implemented and verified today** and what is **staged for later release phases**:

| Area | Current Status | Notes |
|---|---|---|
| `dsh-self-studio` DSH Plugin | **Release-prepared (`v0.1.0`)** | Self-contained bundle with zero `workspace:*`, explicit `engines.dsh: ">=0.2.2-rc.1 <0.3.0"`, verified against official `dsh@0.2.2-rc.1` Desktop and `dsh@0.2.2-rc.5` (0 unmet requirements, live RPC + preview/fetch worker smoke passed), Track A Creator Gate, and a 10-gate release checker |
| Unit & Contract Tests | **32 / 32 passing** | 8 test files covering `product-spec`, catalog admission & 13-peer conflict blocking, OOXML safety/sandbox viewer, `sharp` tiled ultra-long PNG export, SSRF blocking, 6-step Studio lifecycle, Electron Desktop `ELECTRON_RUN_AS_NODE` worker propagation, dual-slot rollback, redacted diagnostics, NSIS macros, and Linux/macOS stagers |
| Windows x64 NSIS Installers | **Verified E2E on Windows 11 (5 real installers)** | Immutable `base-shell` (Node 26.12.1 + Electron 44.11.5 + deduplicated `dsh@0.2.2-rc.5`) + hardened Electron Fuses + pure-JS `resedit` PE stamping + `electron-builder --prepackaged`; `scripts/verify-win-e2e.mjs` passed all 5 real NSIS `.exe` installers end-to-end: silent install & Fuse check, cold launch `/api/product-spec` HTTP 200 with zero orphan Host, side-by-side coexistence, same-name shortcut disambiguation, rename upgrade (stable port + dual-slot switch + packaged redacted diagnostics with 0 leaked secrets), NSIS downgrade block (exit code `1638`), and unilateral uninstall |
| Linux `.deb` & macOS `.dmg` | **Stagers & cross-OS recipes ready** | Studio generates portable transfer bundles, GitHub Actions workflows, and Docker/remote build scripts; `/opt/<slug>`, ASCII `.app` + inside-out codesign ordering are unit-tested; native Linux/macOS host installation verification is a follow-up stage |
| Commercial Signing & Public Channels | **Separate release stage** | Locally built installers are marked `unsigned-local-test` (no commercial certificate; internet downloads will show SmartScreen/Gatekeeper warnings). Public npm / GitHub / `dsh.pub` publication follows [docs/RELEASING.md](docs/RELEASING.md) |

---

## Quick Start

### Prerequisites

- **Node.js** `>= 24.9` (baseline `26.12.1`)
- **pnpm** `11.28.5` for workspace installs (`npx --yes pnpm@11.28.5`)
- **Official DeepSeek Harness** `>= 0.2.2-rc.1 < 0.3.0` (verified live on official `0.2.2-rc.1` Desktop and `0.2.2-rc.5`; generated standalone clients embed pinned `dsh@0.2.2-rc.5`)

### Option 1: Install `dsh-self-studio` into official `dsh@0.2.2-rc.5`

```bash
# 1. Pack & run all 10 plugin release verification gates -> produces .tgz tarball
node scripts/prepare-plugin-release.mjs --pack

# 2. Install into your official dsh profile (web or desktop)
dsh plugin --profile web add .dev/plugin-release/dsh-self-studio-0.1.0.tgz

# 3. Start official dsh web and click "Build My Client" in the sidebar
dsh web
```

> Once published to npm, install directly with `dsh plugin --profile web add dsh-self-studio@0.1.0`, or add the custom DSH plugin index `https://dsh-self.octoooo.com/dsh/index.json` under **Settings → Plugins → Discover**.

### Option 2: Launch an isolated official `dsh web` demo from this workspace

```bash
npm run build
node scripts/launch-official-dsh-demo.mjs
```

This packs the self-contained `dsh-self-studio` bundle into `.dev/official-dsh-demo/dsh-home` and starts official `dsh@0.2.2-rc.5 web` (default `http://127.0.0.1:14567`), printing a tokenized local URL.

---

## 6-Step Studio Workflow

1. **Requirements**: Start from a single sentence (or four built-in starter templates), optionally expand into an editable full brief via your `dsh` default model (with deterministic offline fallback), attach a reference image or SSRF-guarded URL, or import an existing `product.json`.
2. **Blueprints**: Compare **Lite**, **Standard**, and **Pro** blueprints with live 1:1 light/dark desktop shell previews and minimal clarifying questions.
3. **Plugins**: Curated whitelist selection enforcing 4-step static admission and 6-dimension conflict detection (`entryIds`, `httpRoutes`, `panelIds`, `exclusiveSlots`, shortcuts, service names), automatic detection of locally installed DSH plugins, per-action overrides, and MCP alternatives when host peer conflicts occur.
4. **Appearance**: Edit bilingual display names, semver version, app icon (4 SVG presets or uploaded PNG/JPG/WebP), 8 semantic color seeds (deterministically deriving 110+ `--dsw-*` CSS tokens with WCAG 4.5:1 contrast clamping), 4 closed-set layout presets (`single-column`, `list-detail`, `three-pane`, `dashboard-grid`), and home modules.
5. **Preview & Tweak**: Launch an isolated child-process preview with desktop/narrow viewport switches, sub-second hot refresh for visual changes, conversational natural-language refinement, and one-click revision rollback.
6. **Build & Release**: Target Windows x64 locally or emit cross-platform recipes (portable transfer bundle, GitHub Actions CI workflow, or Docker/remote script) for Linux `.deb` and macOS `.dmg`, with SHA-256 receipts and persisted release history.

---

## Architecture & Security Boundaries

- **Immutable Identity vs. Mutable Brand**: `productId`, `internalSlug` (<= 21 chars), `appId`, `appUserModelId`, `nsisGuid`, `executableName`, and `userDataDirName` are derived once and frozen. Display names, icons, themes, and layouts evolve across revisions without breaking upgrades; colliding display names across distinct GUIDs auto-disambiguate with `(<shortId>)`, rename upgrades clean stale `.lnk` shortcuts and rewrite `$launchLink`.
- **CaMeL Dual-Channel Taint Isolation**: Visual and webpage extraction splits output into `controlSafe` (closed-set enums & `#RRGGBB` seeds) and `taintedDisplay` (untrusted display text that never re-enters planning prompts).
- **Two-Layer SSRF Defense**: Reference URL fetching runs in an isolated `fetch-worker` child process restricted to `http/https` on ports `80/443`, blocking loopback, RFC1918, link-local / cloud metadata (`169.254.169.254`), CGNAT (`100.64.0.0/10`), NAT64, ULA, and IPv4-mapped IPv6.
- **Hardened Domain Adapters**:
  - **Bid DOCX (`bid-docx`)**: 4-quota ZIP-bomb checks, XXE rejection, stripping of `w:altChunk`, external relationships, and Windows UNC paths; blocks scanned DOCX, encrypted files, and legacy `.doc`; renders previews inside an opaque-origin `<iframe sandbox="allow-scripts" srcdoc>` with strict CSP loaded via lazy async chunk (`client.docx-viewer.js`).
  - **Design Canvas (`design-canvas`)**: Normalizes EXIF orientations (swapping effective dimensions for orientations 5–8), serves bounded preview proxies to stay under Chromium's `16,384 px` GPU texture limit, and composites per-annotation geometric SVG badges via `sharp.composite` to bypass Cairo's `32,767 px` axis ceiling (tested on `2000×40000` images).
- **3-Step Prepackaged Pipeline, Electron Fuses & Dual-Slot Self-Healing**: Read-only `base-shell` ships hardened Electron Fuses (`RunAsNode: false`, `OnlyLoadAppFromAsar: true`, `EnableNodeOptionsEnvironmentVariable: false`, etc.); staging applies pure-JS `resedit` PE stamping before `electron-builder --prepackaged` wraps the installer; generated clients boot from `<userData>/h/profiles/p-<seedHash>` with automatic rollback after 2 failed cold starts and dual downgrade protection (NSIS `customInit` + runtime `state-version.json`).
- **Privacy Defaults & Redacted Diagnostics**: Seed config disables `session-log-deepseek` and `plugin-package-inventory-deepseek`, sets `DSH_TELEMETRY_DISABLED=1`, strips inherited secrets and `NODE_OPTIONS` via a strict env whitelist (while preserving corporate proxies & CA certs), and exports symlink-safe diagnostic archives that physically exclude `.credentials.yaml` and `.env*`.

---

## Repository Layout

```text
dsh-self/
├── packages/
│   ├── product-spec/      # Zod schemas, A2UI closed-set widget/action registries, identity & theme derivation
│   ├── catalog/           # Curated plugin catalog, 4-step admission, 6-dim conflict engine & platform locks
│   ├── adapters/          # bid-docx (safe OOXML parser/exporter) & design-canvas (EXIF/ultra-long PNG)
│   └── dsh-self-studio/   # Official dsh@0.2.2-rc.5 self-contained plugin (Host + React 18 UI + Workers + Skill + Icon/Locale)
├── templates/
│   └── desktop/           # Electron shell, dual-slot self-healing, env whitelist, product theme & shell plugins
├── tools/
│   ├── dsh-client-build/  # DSH client bundler with independent lazy async chunk support
│   └── builder/           # Independent trust-root CLI, base-shell Fuses, NSIS macros & Win/Linux/macOS stagers
├── scripts/
│   ├── build.mjs                  # Full workspace build
│   ├── pack-studio-bundle.mjs     # Pack self-contained dsh-self-studio bundle
│   ├── prepare-plugin-release.mjs # 10-gate DSH plugin release verifier, packer & dist repo sync
│   ├── assemble-base-shell.mjs    # Assemble read-only base-shell with hardened Electron Fuses
│   ├── launch-official-dsh-demo.mjs # Launch isolated official dsh@0.2.2-rc.5 web demo
│   └── verify-win-e2e.mjs         # Real 5-installer Windows x64 E2E verification suite
├── fixtures/              # Qinghe Bids, Qinghe Design, rename upgrade, downgrade & security fixtures
├── tests/                 # Unit tests (7 suites) & upstream dsh@0.2.2-rc.5 contract tests (1 suite)
├── website/               # Bilingual product website deployed at https://dsh-self.octoooo.com/
└── docs/                  # Implementation plan, upstream reference audit & plugin release guide
```

---

## Standalone CLI Builder

`tools/builder` can package any `product.json` + platform lock headlessly outside Studio:

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

This writes the installer, `build-receipt.json` (spec digest, lock digest, `seedHash`, installer SHA-256), and explicit distribution status metadata.

---

## Publishing the `dsh-self-studio` Plugin

A complete 10-gate verification and staging pipeline is ready for npm, GitHub, `dsh.pub`, `dsh.so`, and the official DSH Custom Plugin Index. See [docs/RELEASING.md](docs/RELEASING.md):

```bash
# Run all 10 release gates and produce .dev/plugin-release/dsh-self-studio-0.1.0.tgz + SHA256SUMS.txt
node scripts/prepare-plugin-release.mjs --pack

# Read-only verification against the staged release output
node scripts/prepare-plugin-release.mjs --check

# Sync a clean standalone Git distribution repository (for GitHub installs, dsh.pub & dsh.so)
node scripts/prepare-plugin-release.mjs --sync-dist ../dsh-self-studio
```

---

## Development & Testing

```bash
# Build all packages, desktop template, builder CLI, and studio bundle
npm run build

# Typecheck
npm run typecheck

# Unit tests (30) and upstream contract tests (2)
npm test
npm run test:contract

# Run all 32 Vitest checks
npx vitest run

# Build & test the bilingual website
npm --prefix website test

# Real Windows x64 5-installer E2E suite (requires npm run assemble:base-shell first)
node scripts/verify-win-e2e.mjs
```

---

## Upstream Provenance & Docs

- [Official Website (dsh-self.octoooo.com)](https://dsh-self.octoooo.com/en/) · [Online Guide](https://dsh-self.octoooo.com/en/guide)
- [Implementation Plan (zh)](docs/implementation-plan.md)
- [Upstream References & Verification Notes (zh)](docs/references.md)
- [DSH Plugin Release Guide (zh)](docs/RELEASING.md)
- [Upstream Source Provenance](UPSTREAM_SOURCE.md) (desktop template baseline from `Octo-o-o-o/OctoDeepSeek`; host pinned to `deepseek-ai/deepseek-harness@dsh-v0.2.2-rc.5`)

This is an independent open-source project and is not affiliated with DeepSeek.

---

## License & Commercial Use

`dsh-self` is dual-licensed under **PolyForm Noncommercial License 1.0.0** + **Small Internal Team Grant (≤ 20 internal company users free)** + **OctoLab Commercial License** (see [LICENSE](LICENSE), [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

- **Personal & noncommercial use**: Free (personal use, 100% free non-paywalled sharing, academic research, nonprofit/public institutions).
- **Internal company use (≤ 20 total users)**: **Free, no license required** (strictly internal use only; not sold or billed to external clients).
- **Internal company use exceeding 20 users (> 20)**, or **selling, subscribing, paid client/agency delivery, or white-labeling packaged standalone clients**: Requires a prior written commercial license—contact [`octoooo@octoooo.com`](mailto:octoooo@octoooo.com).
- Third-party community DSH plugins bundled into generated clients remain subject to their respective authors' licenses.
