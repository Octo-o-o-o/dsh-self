import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { escapeHtml, type ProductSpec } from '@dsh-self/product-spec'
import { chromeColorsForTheme } from './identity.js'

/**
 * Render an HTML-escaped local loading or error/safe-mode splash file into `userData`
 * (NEVER mutating `app.asar`!).
 */
export function writeLoadingSplashFile(options: {
  readonly userDataDir: string
  readonly product: ProductSpec
  readonly dark: boolean
  readonly statusMessage: string
  readonly errorDetail?: string
}): string {
  const colors = chromeColorsForTheme(options.product, options.dark)
  const titleZh = escapeHtml(options.product.brand.displayName.zh)
  const titleEn = escapeHtml(options.product.brand.displayName.en)
  const version = escapeHtml(options.product.appVersion)
  const status = escapeHtml(options.statusMessage)
  const errorBlock = options.errorDetail
    ? `<pre class="err">${escapeHtml(options.errorDetail)}</pre>`
    : '<div class="spinner" aria-hidden="true"></div>'

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
<title>${titleZh}</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid;
    place-items: center;
    background: ${colors.backgroundColor};
    color: ${colors.symbolColor};
    font: 14px/1.6 "Segoe UI", system-ui, sans-serif;
  }
  .box {
    max-width: 520px;
    padding: 28px 32px;
    border-radius: 14px;
    border: 1px solid rgba(148,163,184,0.3);
    text-align: center;
  }
  h1 { margin: 0 0 6px; font-size: 20px; }
  .sub { opacity: 0.72; font-size: 13px; margin: 0 0 16px; }
  .status { font-size: 14px; margin: 12px 0; }
  .spinner {
    width: 28px; height: 28px; margin: 14px auto 0;
    border-radius: 50%;
    border: 3px solid rgba(148,163,184,0.35);
    border-top-color: ${colors.symbolColor};
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err {
    text-align: left;
    margin: 14px 0 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(239,68,68,0.12);
    color: #ef4444;
    font: 12px/1.45 Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: auto;
  }
</style>
</head>
<body>
  <div class="box">
    <h1>${titleZh}</h1>
    <p class="sub">${titleEn} · v${version}</p>
    <p class="status">${status}</p>
    ${errorBlock}
  </div>
</body>
</html>`

  const filePath = path.join(options.userDataDir, 'loading-splash.html')
  mkdirSync(options.userDataDir, { recursive: true })
  writeFileSync(filePath, html, 'utf8')
  return filePath
}
