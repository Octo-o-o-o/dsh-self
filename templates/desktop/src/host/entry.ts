/**
 * Isolated per-client dsh Host entrypoint spawned under bundled Node 26.12.1.
 *
 * - Uses official `@deepseek-ai/dsh-app-boot` (`loadLayeredEnv('dsh')`) and
 *   `@deepseek-ai/dsh/profile-boot` (`runProfile`) with zero hardcoded plugin hacks.
 * - Registers IPC shutdown & parent-disconnect orphan watchdog synchronously before any await.
 * - On parent crash, arms an uncancellable 8 s hard timeout + child tree reaping.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOrphanExit } from './orphan-exit.js'
import { readProcessCreationTime } from './process-snapshot.js'
import { endVerifiedChildTrees } from './reap.js'

const ORPHAN_HARD_TIMEOUT_MS = 8_000
const ORPHAN_REAP_GRACE_MS = 4_000

interface RunningProfile {
  shutdown: { shutdown(code: number): Promise<void> }
}

interface ShutdownMessage {
  type?: unknown
}

let exiting = false
let stopRequested = false
let disconnected = !process.connected
let application: Promise<RunningProfile> | undefined
let stopping: Promise<void> | undefined
let ownCreatedAtMs: number | undefined
const realProcessExit = process.exit.bind(process) as (code?: number) => never

void readProcessCreationTime(process.pid).then((value) => {
  if (value !== undefined) ownCreatedAtMs = value
}).catch(() => {})

function writeExitMarker(code: number): void {
  const marker = process.env.DSH_SELF_HOST_EXIT_FILE
  if (marker !== undefined && marker.length > 0) {
    try { writeFileSync(marker, String(code)) } catch { /* diagnostic only */ }
  }
}

function exitNow(code: number): void {
  if (exiting) return
  exiting = true
  writeExitMarker(code)
  realProcessExit(code)
}

function armUncancellableExit(code: number, delayMs: number): void {
  setTimeout(() => {
    writeExitMarker(code)
    realProcessExit(code)
  }, delayMs)
}

const orphan = createOrphanExit({
  timeoutMs: ORPHAN_HARD_TIMEOUT_MS,
  onFire() {
    armUncancellableExit(1, ORPHAN_REAP_GRACE_MS)
    void (async () => {
      try {
        await endVerifiedChildTrees(process.pid, ownCreatedAtMs)
      } catch {
        // Hard deadline guarantees exit.
      }
      exitNow(1)
    })()
  },
})

function maybeStop(): void {
  if (application === undefined || exiting) return
  if (!stopRequested && process.connected) return
  void stop()
}

function stop(): Promise<void> {
  if (stopping !== undefined) return stopping
  let swallowed = false
  stopping = (async () => {
    try {
      const running = await application
      if (running === undefined) {
        exitNow(1)
        return
      }
      const parentGone = disconnected || !process.connected
      if (parentGone) orphan.noteDisconnect()
      if (!parentGone) {
        process.exit = ((code?: number) => {
          swallowed = true
          console.error(`dsh requested process.exit(${String(code)}) during IPC shutdown; keeping root alive for parent tree stop`)
        }) as typeof process.exit
      }
      try {
        await running.shutdown.shutdown(1)
      } finally {
        process.exit = realProcessExit as typeof process.exit
      }
      if (swallowed) {
        if (disconnected || !process.connected) {
          orphan.noteDisconnect()
          exitNow(1)
        } else {
          await new Promise<void>(() => {})
        }
        return
      }
      orphan.disarm()
      exitNow(0)
    } catch (error) {
      process.exit = realProcessExit as typeof process.exit
      orphan.disarm()
      console.error(error)
      exitNow(1)
    }
  })()
  return stopping
}

process.on('message', (message: ShutdownMessage) => {
  if (typeof message === 'object' && message !== null && message.type === 'shutdown') {
    stopRequested = true
    maybeStop()
  }
})

process.on('disconnect', () => {
  if (exiting) return
  disconnected = true
  stopRequested = true
  orphan.noteDisconnect()
  if (stopping === undefined) maybeStop()
})

console.log('dsh-self-host: listening')

function requiredArg(index: number): string {
  const value = process.argv[index]
  if (value === undefined || value.length === 0) {
    throw new Error('host-entry: expected runtimeDir, profile, and port')
  }
  return value
}

async function importFromRuntime(runtimeDir: string, relativePath: string): Promise<Record<string, unknown>> {
  const href = pathToFileURL(path.join(runtimeDir, relativePath)).href
  return await import(href) as Record<string, unknown>
}

async function main(): Promise<void> {
  const runtimeDir = requiredArg(2)
  const profile = requiredArg(3)
  const port = requiredArg(4)
  const patches = process.argv.slice(5).filter((item) => item.length > 0)

  const boot = await importFromRuntime(runtimeDir, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
  const launcher = await importFromRuntime(runtimeDir, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')
  const loadLayeredEnv = boot['loadLayeredEnv'] as (name: string) => unknown
  const runProfile = launcher['runProfile'] as (options: {
    environment: unknown
    profile: string
    patchFiles: readonly string[]
    args: readonly string[]
  }) => Promise<RunningProfile>

  application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile,
    patchFiles: patches,
    args: ['--no-open', '--host', '127.0.0.1', '--port', port],
  })
  maybeStop()
  await application
  if (stopRequested || !process.connected) {
    if (!process.connected) disconnected = true
    stopRequested = true
    await stop()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  exitNow(1)
})
