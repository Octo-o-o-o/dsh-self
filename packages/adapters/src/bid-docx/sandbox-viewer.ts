import { randomBytes } from 'node:crypto'

/** Strict block-path allowlist validated by the parent window on incoming iframe postMessages. */
export const BLOCK_PATH_ALLOWLIST_RE =
  /^(?:body|header\d+|footer\d+)\/(?:p|tbl|sdt)\[\d+\](?:\/(?:tr|tc|p|tbl|sdt)\[\d+\])*$/

export const BOOKMARK_NAME_ALLOWLIST_RE = /^dsh-blk-\d+$/

export interface DomPurifyLike {
  sanitize(dirty: string, config?: Record<string, unknown>): string
}

/**
 * Sanitize `<style>` CSS emitted by `docx-preview` so typography/layout survives while
 * blocking external resource fetches (`@import`, `url(http/https/file)`), legacy IE expressions,
 * and breaking out of `<style>`.
 */
export function sanitizePreviewCss(rawCss: string): string {
  return rawCss
    .replace(/<\/style/gi, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?!data:image\/(?:png|jpeg|webp);base64,)[^)]*\1\s*\)/gi, 'none')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/behavior\s*:[^;]+;?/gi, '')
    .replace(/-moz-binding\s*:[^;]+;?/gi, '')
}

/** Sanitize docx-preview HTML output using DOMPurify with strict tag/attribute allowlist. */
export function sanitizePreviewHtml(rawHtml: string, purifier: DomPurifyLike): string {
  return purifier.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      'article', 'section', 'div', 'p', 'span', 'br', 'hr',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'mark',
      'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
      'a', 'img', 'figure', 'figcaption',
    ],
    ALLOWED_ATTR: ['class', 'style', 'id', 'name', 'colspan', 'rowspan', 'src', 'alt', 'width', 'height', 'data-block-path'],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['data-block-path'],
    ALLOWED_URI_REGEXP: /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'link', 'meta', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'href', 'xlink:href'],
  })
}

export interface OpaqueSandboxSpec {
  readonly sandboxAttr: 'allow-scripts'
  readonly nonce: string
  readonly csp: string
  readonly srcdoc: string
}

/**
 * Build Option B opaque-origin `<iframe sandbox="allow-scripts" srcdoc="...">` document:
 * - NO `allow-same-origin` -> Chromium Site Isolation assigns opaque `null` origin
 * - Strict CSP blocks all network egress (`connect-src 'none'`), inline/untrusted scripts, forms, frames
 * - Minimal (< 35 lines) nonce-authorized bridge script handles `scrollToAnchor`, `highlightBlocks`, `onBlockClick`
 */
export function buildOpaqueDocxSandbox(options: {
  readonly sanitizedHtml: string
  readonly sanitizedCss: string
  readonly nonce?: string
}): OpaqueSandboxSpec {
  const nonce = options.nonce ?? randomBytes(16).toString('hex')
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')

  const safeCss = sanitizePreviewCss(options.sanitizedCss)
  const bridgeScript = `
(function () {
  var BOOKMARK_RE = /^dsh-blk-\\d+$/;
  function clearHighlights() {
    document.querySelectorAll('.dsh-anchor-hl').forEach(function (el) { el.classList.remove('dsh-anchor-hl'); });
  }
  function findAnchor(name) {
    if (!BOOKMARK_RE.test(name)) return null;
    return document.getElementById(name) || document.querySelector('[name="' + name + '"]');
  }
  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'scrollToAnchor' && typeof msg.bookmarkName === 'string') {
      var target = findAnchor(msg.bookmarkName);
      if (target) {
        clearHighlights();
        var host = target.closest('p,tr,div') || target;
        host.classList.add('dsh-anchor-hl');
        host.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else if (msg.type === 'highlightBlocks' && Array.isArray(msg.bookmarkNames)) {
      clearHighlights();
      msg.bookmarkNames.forEach(function (name) {
        var t = typeof name === 'string' ? findAnchor(name) : null;
        if (t) (t.closest('p,tr,div') || t).classList.add('dsh-anchor-hl');
      });
    }
  });
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[id^="dsh-blk-"],[name^="dsh-blk-"]') : null;
    var name = el ? (el.getAttribute('id') || el.getAttribute('name') || '') : '';
    if (BOOKMARK_RE.test(name)) {
      window.parent.postMessage({ type: 'onBlockClick', bookmarkName: name }, '*');
    }
  });
})();`.trim()

  const srcdoc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
${safeCss}
.dsh-anchor-hl { background: rgba(250, 204, 21, 0.35) !important; outline: 2px solid #ca8a04; border-radius: 3px; }
</style>
</head>
<body>
<div id="dsh-docx-root">${options.sanitizedHtml}</div>
<script nonce="${nonce}">${bridgeScript}</script>
</body>
</html>`

  return { sandboxAttr: 'allow-scripts', nonce, csp, srcdoc }
}

/** Validate incoming `postMessage` payload from the opaque DOCX sandbox iframe. */
export function parseSandboxBlockClickMessage(
  data: unknown,
  bookmarkToPath: ReadonlyMap<string, string>,
): { readonly bookmarkName: string; readonly blockPath: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const msg = data as { type?: unknown; bookmarkName?: unknown }
  if (msg.type !== 'onBlockClick' || typeof msg.bookmarkName !== 'string') return null
  if (!BOOKMARK_NAME_ALLOWLIST_RE.test(msg.bookmarkName)) return null
  const blockPath = bookmarkToPath.get(msg.bookmarkName)
  if (blockPath === undefined || !BLOCK_PATH_ALLOWLIST_RE.test(blockPath)) return null
  return { bookmarkName: msg.bookmarkName, blockPath }
}
