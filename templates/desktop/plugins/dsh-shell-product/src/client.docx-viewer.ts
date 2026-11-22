/**
 * Independent async chunk (`client.docx-viewer.ts`, compiled by `dsh-client-build` into
 * `lib/client.docx-viewer.js` and loaded lazily via `require.async('./client.docx-viewer.js')`).
 *
 * Implements Option B opaque-origin `<iframe sandbox="allow-scripts" srcdoc>` DOCX preview
 * with strict random-nonce CSP and DOMPurify sanitization (preserving sanitized `<style>`).
 */
import DOMPurify from 'dompurify'

export interface SandboxedDocxRenderOptions {
  readonly htmlFragment: string
  readonly styleCss?: string
  readonly onAnchorClick?: (anchorId: string) => void
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Sanitize DOCX HTML preserving layout `<style>` while stripping scripts/handlers/external loads. */
export function sanitizeDocxHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, {
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc'],
    ALLOW_DATA_ATTR: true,
  })
}

/** Build opaque-origin `srcdoc` HTML with strict nonce CSP and bidirectional anchor postMessage bridge. */
export function buildDocxViewerSrcdoc(options: SandboxedDocxRenderOptions): {
  readonly srcdoc: string
  readonly nonce: string
} {
  const nonce = randomNonce()
  const safeBody = sanitizeDocxHtml(options.htmlFragment)
  const safeCss = (options.styleCss ?? '').replace(/<\/style/gi, '')
  const csp = [
    `default-src 'none'`,
    `img-src data: blob:`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ')

  const srcdoc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { margin: 16px; font: 14px/1.65 "Segoe UI", system-ui, sans-serif; color: #0f172a; background: #ffffff; }
  [data-dsh-anchor] { padding: 4px 6px; border-radius: 4px; cursor: pointer; }
  [data-dsh-anchor].dsh-hl { background: rgba(15, 118, 110, 0.16); outline: 2px solid #0f766e; }
  ${safeCss}
</style>
</head>
<body>
${safeBody}
<script nonce="${nonce}">
  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'dsh-scroll-anchor' && typeof msg.anchorId === 'string') {
      document.querySelectorAll('.dsh-hl').forEach((el) => el.classList.remove('dsh-hl'));
      const target = document.querySelector('[data-dsh-anchor="' + CSS.escape(msg.anchorId) + '"]');
      if (target) {
        target.classList.add('dsh-hl');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-dsh-anchor]') : null;
    if (el) {
      const anchorId = el.getAttribute('data-dsh-anchor');
      if (anchorId) parent.postMessage({ type: 'dsh-anchor-clicked', anchorId }, '*');
    }
  });
</script>
</body>
</html>`
  return { srcdoc, nonce }
}
