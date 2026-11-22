/**
 * Browser client bundle wrapper for dsh@0.2.2-rc.5 plugins built outside the harness repo.
 * Supports both entry bundles (`lib/client.js`) and self-contained async chunks
 * (`lib/client.<name>.js` with `chunk` property for `require.async("./client.<name>.js")`).
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

export function wrapClientFactory(
  id: string,
  code: string,
  stylesheets: Readonly<Record<string, string>>,
  chunk?: string,
): string {
  const entries = Object.entries(stylesheets)
  const install = entries.length === 0
    ? ''
    : `if (typeof document !== "undefined") { const sheets = ${JSON.stringify(Object.fromEntries(entries))}; for (const sheetPath of Object.keys(sheets)) { const tagId = ${JSON.stringify(id)} + ":" + sheetPath; if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) { const tag = document.createElement("style"); tag.dataset.plugin = ${JSON.stringify(id)}; tag.dataset.pluginCss = tagId; tag.textContent = sheets[sheetPath]; document.head.appendChild(tag); } } }\n`
  const chunkProp = chunk === undefined ? '' : ` chunk: ${JSON.stringify(chunk)},`
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)},${chunkProp} factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${install}${code}\nreturn module.exports; } });\n`
}
