import type { BrowserWindow, Session } from 'electron'
import { shell } from 'electron'
import { allowFrameNavigation, allowTopNavigation, isExternalHttpUrl } from './host/navigation.js'

export interface WindowGuardContext {
  getHostOrigin(): string | undefined
  readonly loadingFile: string
}

/**
 * Default-deny Electron session permissions:
 * blocks geolocation, notifications, camera/mic, HID/USB/Serial, clipboard-read, etc.
 * Allows only `clipboard-sanitized-write` for copy UX.
 */
export function installSessionPermissionGuards(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
  ses.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'clipboard-sanitized-write'
  })
  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false)
  }
}

/**
 * Strict navigation & popup guards for the branded Electron BrowserWindow:
 * - Denies `<webview>` attachment (`will-attach-webview`)
 * - Blocks top-level navigation outside loopback Host origin or loading HTML
 * - Blocks frame navigation outside Host origin / `about:blank` / `about:srcdoc` (for Option B DOCX viewer)
 * - Opens `http:` / `https:` links in OS default browser; denies `file:` / `javascript:` / `data:` popups
 */
export function installWindowNavigationGuards(win: BrowserWindow, guardCtx: WindowGuardContext): void {
  const wc = win.webContents

  wc.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  wc.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  wc.on('will-navigate', (event, url) => {
    if (!allowTopNavigation(url, guardCtx.getHostOrigin(), guardCtx.loadingFile)) {
      event.preventDefault()
      if (isExternalHttpUrl(url)) {
        void shell.openExternal(url)
      }
    }
  })

  wc.on('will-frame-navigate', (details) => {
    const isTop = details.isMainFrame
    const allowed = isTop
      ? allowTopNavigation(details.url, guardCtx.getHostOrigin(), guardCtx.loadingFile)
      : allowFrameNavigation(details.url, guardCtx.getHostOrigin(), guardCtx.loadingFile)
    if (!allowed) {
      details.preventDefault()
    }
  })
}
