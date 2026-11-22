# Third-Party Notices

`dsh-self` incorporates or interfaces with the following third-party open-source software components. Each component remains subject to its own copyright and license terms.

---

## DeepSeek Harness

- Repository: `deepseek-ai/deepseek-harness` (pinned baseline tag `dsh-v0.2.2-rc.5`, commit `9c2670d3bce5275e0d1610272958121af87787bb`)
- License: **MIT License**
- Notes: `tools/dsh-client-build/src/wrap.ts` adapts the published `@deepseek-ai/*@0.2.2-rc.5` browser factory wrapper shape (`window.__ModuleLoader__.load`), and generated desktop clients ship `@deepseek-ai/dsh@0.2.2-rc.5` installed from npm.

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Core Runtime & Build Dependencies

| Package | License | Role in `dsh-self` |
| --- | --- | --- |
| `electron` (and bundled Chromium) | MIT (Chromium components under BSD/MIT/LGPL; full notices shipped in `LICENSES.chromium.html`) | Desktop shell runtime |
| `electron-builder` | MIT | Prepackaged installer packaging (`--prepackaged`) |
| `@electron/fuses` | MIT | Binary security Fuse hardening on `base-shell` |
| `resedit` | MIT | Pure-JS Windows PE icon & version resource stamping |
| `esbuild` | MIT | TypeScript/React client & worker bundling |
| `sharp` (and dynamically linked `libvips`) | Apache-2.0 (`libvips`: LGPL-3.0-or-later, dynamically linked) | EXIF normalization, bounded preview proxy & tiled PNG export |
| `docx-preview` | Apache-2.0 | Lazy-loaded sandboxed DOCX HTML rendering |
| `dompurify` | Apache-2.0 (dual-licensed MPL-2.0 OR Apache-2.0; used under Apache-2.0) | HTML/CSS sanitization before opaque-origin iframe preview |
| `fflate` | MIT | ZIP/OOXML parsing & diagnostic archive packing |
| `ipaddr.js` | MIT | IPv4/IPv6 CIDR validation for SSRF defense |
| `zod` | MIT | Strict schema validation for `product.json` and briefs |
| `yaml` | ISC | Core-schema YAML parsing (`!!js` disabled) |
| `semver` | ISC | Semantic version comparison & range validation |
| `react` / `react-dom` | MIT | Studio & shell UI components |
| `NSIS` | zlib/libpng | Windows installer wrapper |

---

## Community DSH Plugins

Any third-party community DSH plugins listed in `packages/catalog` or installed/bundled by users (such as `dsh-plugin-bidkit`, `dsh-design-studio`, `dsh-calendar`, `dsh-email`, `@chaiyahang/dsh-scratchpad`, `@alpacachen/dsh-kanban`, etc.) are independent works governed by their respective authors' licenses.
