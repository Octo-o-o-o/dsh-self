# Changelog

All notable changes to **dsh-self** and the **dsh-self-studio** plugin bundle will be documented in this file.

## [0.1.0] - 2026-11-22 (Release Preparation)

### Added
- **Official DSH Plugin (`dsh-self-studio`)**:
  - Self-contained official `dsh` bundle (`engines.dsh: ">=0.2.2-rc.1 <0.3.0"`, zero `workspace:*`, plain Core-YAML `cordis.patch.yml`), live-verified on both official `DeepSeek Harness 0.2.2-rc.1` Desktop (including Electron `ELECTRON_RUN_AS_NODE=1` child-worker propagation) and `dsh@0.2.2-rc.5`.
  - 6-step Studio workbench: Requirements (with `dsh` default-model expansion + offline fallback + CaMeL taint separation), 3-tier Blueprints with live 1:1 preview, Curated Whitelist Plugin Selection with local installed-plugin scan, Appearance & Brand Icon Studio, Isolated Preview with conversational NL refinement & revision rollback, and Multi-target Build & Release Version Manager.
  - Plugin publishing assets: `icon.svg`, bilingual `locale/{zh,en}.json`, bilingual plugin `README.md` / `README.en.md`, and `scripts/prepare-plugin-release.mjs` with 10 automated release verification gates.
- **Core Packages & Adapters**:
  - `@dsh-self/product-spec`: Zod schemas, frozen identity derivation, A2UI closed-set widget/action registries, and 8-seed deterministic theme derivation with WCAG 4.5:1 clamping.
  - `@dsh-self/catalog`: 4-step static admission, 6-dimension conflict engine, trust tiers, and per-platform lock generation.
  - `@dsh-self/adapters`: Hardened `bid-docx` (ZIP-bomb/XXE/UNC stripping + opaque-origin sandboxed preview) and `design-canvas` (EXIF normalization + tiled `sharp.composite` PNG export verified up to `2000x40000`).
- **Desktop Template, Independent Builder & Real Windows E2E (`templates/desktop`, `tools/builder`)**:
  - Immutable `base-shell` with hardened Electron Fuses, deduplicated `dsh@0.2.2-rc.5` runtime, pure-JS `resedit` PE stamping, hardened NSIS macros (coexistence, same-name disambiguation, rename upgrade, downgrade block), dual-slot `p-<seedHash>` self-healing, minimal env whitelist, privacy-first seed defaults, and redacted diagnostic bundle export (including standalone `token=` redaction).
  - Verified end-to-end on Windows 11 across 5 real NSIS `.exe` installers (`scripts/verify-win-e2e.mjs`): silent install & Electron Fuses, live cold launch (`/api/product-spec` HTTP 200, zero orphan Host), coexistence, same-name shortcut disambiguation, rename upgrade (`v0.1.0 → v0.2.0`), dual-slot switch, packaged redacted diagnostic export (0 leaked secrets), NSIS downgrade block (exit code `1638`), and unilateral uninstall.
  - Cross-platform Linux `.deb` and macOS `.app`/`.dmg` stagers plus portable bundle, GitHub Actions, and Docker/remote recipes.
- **Licensing & Third-Party Notices**:
  - Dual-licensed under **PolyForm Noncommercial License 1.0.0** + **Small Internal Team Grant (≤ 20 internal company users free)** + **OctoLab Commercial License** (`COMMERCIAL-LICENSE.md`, `octoooo@octoooo.com`), accompanied by `THIRD_PARTY_NOTICES.md`.
- **Official Website (`website/`)**:
  - Bilingual (`zh-CN` / `en`) responsive static website (320px–3840px) deployed to `https://dsh-self.octoooo.com/`, including official DSH Custom Plugin Index (`/dsh/index.json`) and automated build/worker tests.
