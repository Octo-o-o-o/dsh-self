import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildWhitelistedHostEnv } from './env-whitelist.js'
import { ReadyLineBuffer, assertReadyOrigin } from './navigation.js'
import { renderLaunchOverlay, type OverlayPlugin } from './overlay.js'
import { forgetHostPid, readHostRecords, rememberHost } from './pid-file.js'
import { acquireStablePort, portBindFailed } from './port-pool.js'
import { enforcePosixDirMode, enforcePosixFileMode } from './posix-perms.js'
import { readProcessCreationTime } from './process-snapshot.js'
import { reapStaleRecordedHosts } from './reap.js'
import { createRotatingLog } from './rotating-log.js'
import type { AppLayout } from './runtime-paths.js'
import { HOST_STOP_GRACE_MS, forceKillTree, runStopSequence } from './stop.js'

export const HOST_READY_TIMEOUT_MS = 90_000

export interface RunningDesktopHost {
  readonly pid: number
  readonly port: number
  readonly readyUrl: string
  readonly origin: string
  readonly logFile: string
  stop(): Promise<'graceful' | 'forced'>
}

export interface LaunchDesktopHostOptions {
  readonly layout: AppLayout
  readonly userDataDir: string
  readonly dshHome: string
  readonly productDir: string
  readonly profileSlot: string
  readonly overlayPlugins: readonly OverlayPlugin[]
  readonly previewMode?: boolean
  readonly disableToolWeb?: boolean
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

function writeShimDir(userDataDir: string, nodePath: string, pnpmPackageDir: string): string | undefined {
  const shimDir = path.join(userDataDir, 'bin')
  mkdirSync(shimDir, { recursive: true })
  const pnpmCli = path.join(pnpmPackageDir, 'bin', 'pnpm.cjs')
  if (process.platform === 'win32') {
    writeFileSync(path.join(shimDir, 'node.cmd'), `@echo off\r\n"${nodePath}" %*\r\n`)
    if (existsSync(pnpmCli)) {
      writeFileSync(path.join(shimDir, 'pnpm.cmd'), `@echo off\r\n"${nodePath}" "${pnpmCli}" %*\r\n`)
    }
  } else {
    const nodeShim = path.join(shimDir, 'node')
    writeFileSync(nodeShim, `#!/bin/sh\nexec "${nodePath}" "$@"\n`, { mode: 0o755 })
    enforcePosixFileMode(nodeShim, 0o755)
    if (existsSync(pnpmCli)) {
      const pnpmShim = path.join(shimDir, 'pnpm')
      writeFileSync(pnpmShim, `#!/bin/sh\nexec "${nodePath}" "${pnpmCli}" "$@"\n`, { mode: 0o755 })
      enforcePosixFileMode(pnpmShim, 0o755)
    }
  }
  return shimDir
}

/**
 * Launch the isolated per-client Node 26.12.1 dsh Host with:
 * - Cold-start stale PID + creationTime reaping
 * - Stable Origin port pool (`preferredPort` / `fallbackPort` / `conflictStreak`)
 * - Minimal whitelisted environment (`NODE_OPTIONS` / `DEEPSEEK_API_KEY` / `DSH_*` blocked)
 * - Structured YAML `--patch` overlay
 * - Rotating log (`logs/host.log`) with 0600 perms on POSIX
 */
export async function launchDesktopHost(options: LaunchDesktopHostOptions): Promise<RunningDesktopHost> {
  mkdirSync(options.userDataDir, { recursive: true })
  mkdirSync(options.dshHome, { recursive: true })
  enforcePosixDirMode(options.userDataDir, 0o700)
  enforcePosixDirMode(options.dshHome, 0o700)

  const pidFile = path.join(options.userDataDir, 'host-pids.json')
  const staleRecords = readHostRecords(pidFile)
  if (staleRecords.length > 0) {
    await reapStaleRecordedHosts(staleRecords).catch(() => {})
    for (const rec of staleRecords) forgetHostPid(pidFile, rec.pid)
  }

  const overlayPath = path.join(options.userDataDir, 'launch-overlay.patch.yml')
  const overlayYaml = renderLaunchOverlay({
    plugins: options.overlayPlugins,
    previewMode: options.previewMode,
    disableToolWeb: options.disableToolWeb,
  })
  writeFileSync(overlayPath, overlayYaml, 'utf8')
  enforcePosixFileMode(overlayPath, 0o600)

  const nodeExec = options.layout.nodePath ?? process.execPath
  const shimDir = options.layout.packaged
    ? writeShimDir(options.userDataDir, nodeExec, options.layout.pnpmPackageDir)
    : undefined

  const env = buildWhitelistedHostEnv({
    sourceEnv: process.env,
    dshHome: options.dshHome,
    shimDir,
    extraAllowed: {
      DSH_SELF_PRODUCT_DIR: path.resolve(options.productDir),
      ...(options.previewMode ? { DSH_SELF_WORKSPACES_ROOT: path.join(options.userDataDir, 'workspaces') } : {}),
      DSH_SELF_USER_DATA_DIR: path.resolve(options.userDataDir),
    },
  })

  const logFile = path.join(options.userDataDir, 'logs', 'host.log')
  const log = createRotatingLog(logFile)

  let lastError = 'Host failed to start'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { port } = await acquireStablePort(options.dshHome)
    const args = [
      options.layout.hostEntry,
      options.layout.runtimeDir,
      options.profileSlot,
      String(port),
      overlayPath,
    ]
    const child: ChildProcess = spawn(nodeExec, args, {
      cwd: options.layout.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    const pid = child.pid ?? 0
    const createdAtMs = pid > 0 ? ((await readProcessCreationTime(pid)) ?? Date.now()) : Date.now()
    if (pid > 0) rememberHost(pidFile, { pid, createdAtMs })

    let stderrBuf = ''
    const readyBuffer = new ReadyLineBuffer()

    const readyOutcome = await new Promise<{ ok: true; readyUrl: string; origin: string } | { ok: false; detail: string }>((resolve) => {
      let settled = false
      const finish = (res: { ok: true; readyUrl: string; origin: string } | { ok: false; detail: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(res)
      }
      const timer = setTimeout(() => {
        finish({ ok: false, detail: `Host timed out after ${HOST_READY_TIMEOUT_MS}ms waiting for ready URL` })
      }, HOST_READY_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        log.write(text)
        const ready = readyBuffer.push(text)
        if (ready !== null) {
          try {
            const origin = assertReadyOrigin(ready.url, port)
            finish({ ok: true, readyUrl: ready.url, origin })
          } catch (err) {
            finish({ ok: false, detail: err instanceof Error ? err.message : String(err) })
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        stderrBuf += text
        log.write(text)
      })
      child.once('error', (err) => finish({ ok: false, detail: err.message }))
      child.once('exit', (code, signal) => {
        finish({ ok: false, detail: `Host exited early (code=${String(code)}, signal=${String(signal)}): ${stderrBuf.slice(-400)}` })
      })
    })

    if (readyOutcome.ok) {
      child.on('exit', (code, signal) => {
        if (pid > 0) forgetHostPid(pidFile, pid)
        log.close()
        options.onExit?.(code, signal)
      })
      return {
        pid,
        port,
        readyUrl: readyOutcome.readyUrl,
        origin: readyOutcome.origin,
        logFile,
        async stop() {
          const outcome = await runStopSequence({
            requestShutdown() {
              try {
                if (child.connected) child.send({ type: 'shutdown' })
              } catch { /* ignore */ }
            },
            waitForExit(timeoutMs) {
              if (child.exitCode !== null) return Promise.resolve(true)
              return new Promise<boolean>((resolve) => {
                const t = setTimeout(() => resolve(false), timeoutMs)
                child.once('exit', () => { clearTimeout(t); resolve(true) })
              })
            },
            async forceKillTree() {
              if (pid > 0) await forceKillTree(pid)
            },
          }, HOST_STOP_GRACE_MS)
          if (pid > 0) forgetHostPid(pidFile, pid)
          log.close()
          return outcome
        },
      }
    }

    lastError = readyOutcome.detail
    if (pid > 0) {
      await forceKillTree(pid).catch(() => {})
      forgetHostPid(pidFile, pid)
    }
    if (!portBindFailed(lastError)) break
  }

  log.close()
  throw new Error(lastError)
}
