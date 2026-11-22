/**
 * Parameterized Electron Main process for dsh-self generated standalone desktop clients.
 *
 * Strictly enforces every isolation & upgrade invariant:
 * 1. Synchronously loads `resources/product/{product.json,identity.json}` BEFORE `requestSingleInstanceLock()`
 * 2. Calls `app.setName`, `app.setPath('userData'|'sessionData'|'crashDumps')`, `app.setAppUserModelId`
 *    BEFORE `requestSingleInstanceLock()` so multiple generated apps & official dsh coexist cleanly
 * 3. Checks `state-version.json` to block data-format / session-format downgrade BEFORE mutating userData
 * 4. Runs dual-slot profile (`<dshHome>/profiles/p-<shortHash>`) with 2-consecutive-failure automatic
 *    same-runtime rollback & safe-mode recovery
 * 5. Enforces composite health probe (Host ready + `/api/product-spec` HTTP 200 + main window load)
 * 6. Exposes Help -> Export Redacted Diagnostic Bundle & Export `product.json`
 */
import { app, BrowserWindow, dialog, Menu, nativeTheme, session } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PINNED_DSH_RUNTIME_VERSION,
  SeedManifestSchema,
  type SeedManifest,
} from '@dsh-self/product-spec'
import { exportRedactedDiagnosticBundle } from './host/diagnostics.js'
import { launchDesktopHost, type RunningDesktopHost } from './host/launch.js'
import {
  ensureDualSlotProfile,
  handleSlotBootFailure,
  markSlotVerified,
  recordSlotBootAttempt,
} from './host/profile-slots.js'
import { pluginEntryPath, resolveAppLayout } from './host/runtime-paths.js'
import { checkUserDataDowngrade, recordStateVersion } from './host/state-version.js'
import {
  chromeColorsForTheme,
  loadProductRuntimeConfigSync,
  localizedDisplayName,
  resolveProductDir,
} from './identity.js'
import { writeLoadingSplashFile } from './loading.js'
import { installSessionPermissionGuards, installWindowNavigationGuards } from './window-guards.js'

function reportFatalSmokeError(err: unknown): void {
  const reportFile = process.env.DSH_SELF_SMOKE_REPORT_FILE
  if (reportFile) {
    try {
      writeFileSync(reportFile, `${JSON.stringify({ ok: false, fatal: err instanceof Error ? err.stack ?? err.message : String(err) }, undefined, 2)}\n`)
    } catch { /* ignore */ }
    process.exit(1)
  }
}
process.on('uncaughtException', reportFatalSmokeError)
process.on('unhandledRejection', reportFatalSmokeError)

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(moduleDir, '..', '..', '..')
const productDir = resolveProductDir({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
const config = loadProductRuntimeConfigSync(productDir)
const { product, identity } = config
const slug = product.identity.internalSlug

// Step 1: Isolate system identity & userData/sessionData/crashDumps SYNCHRONOUSLY before single-instance lock!
const trialRoot = process.env.DSH_SELF_TRIAL_ROOT && path.resolve(process.env.DSH_SELF_TRIAL_ROOT)
const userDataDir = trialRoot ? path.join(trialRoot, 'data') : path.join(app.getPath('appData'), slug)
if (trialRoot && process.send) {
  process.on('message', message => {
    if ((message as { type?: string })?.type === 'close-trial') app.quit()
    if ((message as { type?: string })?.type === 'focus-trial') mainWindow?.focus()
  })
  process.on('disconnect', () => app.quit())
}
const sessionDataDir = path.join(userDataDir, 'session')
const crashDumpsDir = path.join(userDataDir, 'crashes')
const dshHome = path.join(userDataDir, 'h')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(sessionDataDir, { recursive: true })
mkdirSync(crashDumpsDir, { recursive: true })
mkdirSync(dshHome, { recursive: true })

app.setName(slug)
app.setPath('userData', userDataDir)
app.setPath('sessionData', sessionDataDir)
app.setPath('crashDumps', crashDumpsDir)
if (process.platform === 'win32') {
  app.setAppUserModelId(identity.identity.appUserModelId)
}

// Step 2: Single-instance lock is now scoped strictly to this product's isolated userDataDir!
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
let activeHost: RunningDesktopHost | null = null
let hostOrigin: string | undefined
let shuttingDown = false
let loadingFile = ''

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

function loadSeedManifest(): { readonly manifest: SeedManifest; readonly archivePath: string } | null {
  const manifestPath = path.join(productDir, 'seed-manifest.json')
  const archivePath = path.join(productDir, 'profile-seed.tar.gz')
  if (!existsSync(manifestPath) || !existsSync(archivePath)) return null
  return {
    manifest: SeedManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))),
    archivePath,
  }
}

async function verifyCompositeHealth(origin: string, readyUrl: string): Promise<{ readonly ok: boolean; readonly productSpecStatus: number }> {
  try {
    const authRes = await fetch(readyUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
    const rawCookie = authRes.headers.get('set-cookie') ?? ''
    const cookieHeader = rawCookie
      .split(/,(?=[^;]+=)/)
      .map((part) => part.split(';')[0]?.trim() ?? '')
      .filter(Boolean)
      .join('; ')
    const specRes = await fetch(`${origin}/api/product-spec`, {
      method: 'GET',
      headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      signal: AbortSignal.timeout(8_000),
    })
    return {
      ok: specRes.status === 200,
      productSpecStatus: specRes.status,
    }
  } catch {
    return { ok: false, productSpecStatus: 0 }
  }
}

function buildAppMenu(displayName: string): Menu {
  return Menu.buildFromTemplate([
    {
      label: displayName,
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '帮助 (Help)',
      submenu: [
        {
          label: '导出 product.json（用于二次迭代或跨系统打包）',
          click: async () => {
            const picked = await dialog.showSaveDialog({
              title: '导出 product.json',
              defaultPath: path.join(os.homedir(), `${slug}-product.json`),
              filters: [{ name: 'JSON', extensions: ['json'] }],
            })
            if (!picked.canceled && picked.filePath) {
              copyFileSync(path.join(productDir, 'product.json'), picked.filePath)
            }
          },
        },
        {
          label: '导出脱敏诊断包 (Export Redacted Diagnostic Bundle)',
          click: async () => {
            const picked = await dialog.showSaveDialog({
              title: '导出脱敏诊断包',
              defaultPath: path.join(os.homedir(), `${slug}-diagnostics.zip`),
              filters: [{ name: 'ZIP', extensions: ['zip'] }],
            })
            if (!picked.canceled && picked.filePath) {
              exportRedactedDiagnosticBundle({
                productDir,
                userDataDir,
                outputZipPath: picked.filePath,
              })
            }
          },
        },
      ],
    },
  ])
}

async function bootClient(): Promise<void> {
  const displayName = localizedDisplayName(product.brand.displayName, app.getLocale())
  const dark = nativeTheme.shouldUseDarkColors
  const colors = chromeColorsForTheme(product, dark)

  if (typeof app.setAboutPanelOptions === 'function') {
    app.setAboutPanelOptions({
      applicationName: displayName,
      applicationVersion: product.appVersion,
      version: `r${product.revision}`,
    })
  }
  Menu.setApplicationMenu(buildAppMenu(displayName))

  const ses = session.defaultSession
  installSessionPermissionGuards(ses)

  // Step 3: Runtime downgrade check BEFORE touching userData or launching Host!
  const downgrade = checkUserDataDowngrade(userDataDir, {
    dataFormatVersion: product.dataFormatVersion,
    dshSessionFormatVersion: product.dshSessionFormatVersion,
  })

  loadingFile = writeLoadingSplashFile({
    userDataDir,
    product,
    dark,
    statusMessage: !downgrade.blocked
      ? `正在启动 ${displayName} 独立工作台…`
      : '检测到更高版本的数据目录，已阻止降级启动以保护您的数据',
    ...(!downgrade.blocked ? {} : { errorDetail: downgrade.reason }),
  })

  const headlessSmoke = process.env.DSH_SELF_SMOKE_HEADLESS === '1'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 768,
    minHeight: 560,
    show: !headlessSmoke,
    title: displayName,
    backgroundColor: colors.backgroundColor,
    ...(config.iconPngPath ? { icon: config.iconPngPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  installWindowNavigationGuards(mainWindow, {
    getHostOrigin: () => hostOrigin,
    loadingFile,
  })
  await mainWindow.loadFile(loadingFile)

  if (downgrade.blocked) {
    if (process.env.DSH_SELF_SMOKE_REPORT_FILE) {
      writeFileSync(process.env.DSH_SELF_SMOKE_REPORT_FILE, `${JSON.stringify({
        ok: false,
        blockedDowngrade: true,
        reason: downgrade.reason,
        slug,
        appVersion: product.appVersion,
      }, undefined, 2)}\n`)
      app.quit()
    }
    return
  }

  // Step 4: Dual-slot profile preparation (`<dshHome>/profiles/p-<shortHash>`)
  const seed = loadSeedManifest()
  let profileSlot = 'p-dev'
  if (seed !== null) {
    const prep = ensureDualSlotProfile({
      userDataDir,
      dshHome,
      seedArchivePath: seed.archivePath,
      seedManifest: seed.manifest,
    })
    profileSlot = prep.state.active
    if (prep.state.state === 'safe_mode') {
      loadingFile = writeLoadingSplashFile({
        userDataDir,
        product,
        dark,
        statusMessage: '已进入安全模式（Safe Mode）：新版本连续启动失败且无法回滚，请在菜单中导出脱敏诊断包或重装上一版本。',
        errorDetail: `active=${prep.state.active} failedSlotHash=${String(prep.state.failedSlotHash)}`,
      })
      await mainWindow.loadFile(loadingFile)
      return
    }
    recordSlotBootAttempt(userDataDir)
  } else {
    const devSlotDir = path.join(dshHome, 'profiles', profileSlot)
    mkdirSync(devSlotDir, { recursive: true })
    const devPkgPath = path.join(devSlotDir, 'package.json')
    if (!existsSync(devPkgPath)) {
      writeFileSync(
        devPkgPath,
        `${JSON.stringify({
          name: `dsh-profile-${slug}`,
          version: product.appVersion,
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
            },
          },
        }, undefined, 2)}\n`,
      )
    }
    if (!existsSync(path.join(devSlotDir, 'cordis.yml'))) {
      writeFileSync(path.join(devSlotDir, 'cordis.yml'), '[]\n')
    }
    if (!existsSync(path.join(devSlotDir, 'cordis.patch.yml'))) {
      writeFileSync(
        path.join(devSlotDir, 'cordis.patch.yml'),
        "- id: session-log-deepseek\n  config:\n    enabled: false\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: '2026-09-28.1'\n",
      )
    }
    if (!existsSync(path.join(devSlotDir, 'pnpm-workspace.yaml'))) {
      writeFileSync(
        path.join(devSlotDir, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      )
    }
  }

  const layout = resolveAppLayout({
    packaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
    moduleDir,
  })

  const overlayPlugins = [
    { id: 'dsh-theme-product', entry: pluginEntryPath(layout.pluginsDir, 'dsh-theme-product', 'index.js') },
    { id: 'dsh-shell-product', entry: pluginEntryPath(layout.pluginsDir, 'dsh-shell-product', 'dist/host.js') },
  ].filter((p) => existsSync(p.entry))

  try {
    activeHost = await launchDesktopHost({
      layout,
      userDataDir,
      dshHome,
      productDir,
      profileSlot,
      overlayPlugins,
      previewMode: Boolean(trialRoot),
      disableToolWeb: product.shell.localOnlyToolWebDisabled,
      onExit: (code) => {
        if (!shuttingDown && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
          const errFile = writeLoadingSplashFile({
            userDataDir,
            product,
            dark,
            statusMessage: '后台工作台服务意外退出，请重新启动或导出诊断包。',
            errorDetail: `Host exited with code ${String(code)}`,
          })
          void mainWindow.loadFile(errFile)
        }
      },
    })
    hostOrigin = activeHost.origin

    // Composite health check
    const health = await verifyCompositeHealth(activeHost.origin, activeHost.readyUrl)
    if (!health.ok) {
      throw new Error(`Composite health check failed: Host /api/product-spec returned status ${health.productSpecStatus}`)
    }

    await mainWindow.loadURL(activeHost.readyUrl)

    if (trialRoot && process.send) {
      const ready = await mainWindow.webContents.executeJavaScript(`new Promise(resolve => {
        const ready = () => document.querySelector('[data-dsh-product-ready]')?.getAttribute('data-dsh-product-ready') === ${JSON.stringify(product.identity.productId)};
        if (ready()) return resolve(true);
        const observer = new MutationObserver(() => { if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(true); } });
        const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, 30000);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      })`)
      if (!ready) throw new Error('桌面业务首页未就绪 / Product home did not mount')
      process.send({ type: 'trial-ready' })
    }

    // Mark active profile slot healthy & record high-water state-version.json
    if (seed !== null) {
      markSlotVerified(userDataDir, dshHome)
    }
    recordStateVersion(userDataDir, {
      dataFormatVersion: product.dataFormatVersion,
      dshSessionFormatVersion: product.dshSessionFormatVersion,
      appVersion: product.appVersion,
    })

    if (process.env.DSH_SELF_SMOKE_REPORT_FILE) {
      const diagZip = process.env.DSH_SELF_SMOKE_DIAGNOSTICS_ZIP
      if (diagZip) {
        exportRedactedDiagnosticBundle({
          productDir,
          userDataDir,
          outputZipPath: diagZip,
        })
      }
      writeFileSync(process.env.DSH_SELF_SMOKE_REPORT_FILE, `${JSON.stringify({
        ok: true,
        slug,
        appId: identity.identity.appId,
        appVersion: product.appVersion,
        displayName,
        userDataDir,
        dshHome,
        profileSlot,
        hostOrigin,
        hostPid: activeHost.pid,
        hostPort: activeHost.port,
        productSpecStatus: health.productSpecStatus,
      }, undefined, 2)}\n`)
      setTimeout(() => { app.quit() }, 500)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (trialRoot && process.send) process.send({ type: 'trial-error', detail })
    if (seed !== null) {
      const outcome = handleSlotBootFailure(
        userDataDir,
        dshHome,
        seed.manifest.dshRuntimeVersion || PINNED_DSH_RUNTIME_VERSION,
      )
      if (outcome.action === 'rolled_back' && outcome.state) {
        // Retry immediately on the rolled-back healthy slot!
        try {
          activeHost = await launchDesktopHost({
            layout,
            userDataDir,
            dshHome,
            productDir,
            profileSlot: outcome.state.active,
            overlayPlugins,
            previewMode: Boolean(trialRoot),
            disableToolWeb: product.shell.localOnlyToolWebDisabled,
          })
          hostOrigin = activeHost.origin
          await mainWindow.loadURL(activeHost.readyUrl)
          markSlotVerified(userDataDir, dshHome)
          return
        } catch { /* fall through to error splash */ }
      }
    }
    loadingFile = writeLoadingSplashFile({
      userDataDir,
      product,
      dark,
      statusMessage: `启动 ${displayName} 失败，请在菜单中导出脱敏诊断包。`,
      errorDetail: detail,
    })
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadFile(loadingFile)
    }
    if (process.env.DSH_SELF_SMOKE_REPORT_FILE) {
      writeFileSync(process.env.DSH_SELF_SMOKE_REPORT_FILE, `${JSON.stringify({
        ok: false,
        slug,
        error: detail,
      }, undefined, 2)}\n`)
      app.quit()
    }
  }
}

app.whenReady().then(() => {
  void bootClient()
})

app.on('before-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  if (activeHost !== null) {
    event.preventDefault()
    const hostToStop = activeHost
    activeHost = null
    void hostToStop.stop().finally(() => {
      app.quit()
    })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
