import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const FILE_NAME = 'port-pool.json'
export const PROMOTE_CONFLICT_STREAK = 3

export interface PortPoolState {
  readonly preferredPort: number
  readonly fallbackPort: number
  readonly conflictStreak: number
}

export function portPoolPath(dshHome: string): string {
  return path.join(dshHome, FILE_NAME)
}

export function readPortPool(dshHome: string): PortPoolState | null {
  const file = portPoolPath(dshHome)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PortPoolState>
    if (
      typeof parsed.preferredPort === 'number' && Number.isInteger(parsed.preferredPort) &&
      parsed.preferredPort > 0 && parsed.preferredPort <= 65535 &&
      typeof parsed.fallbackPort === 'number' && Number.isInteger(parsed.fallbackPort) &&
      parsed.fallbackPort > 0 && parsed.fallbackPort <= 65535 &&
      typeof parsed.conflictStreak === 'number' && Number.isInteger(parsed.conflictStreak) &&
      parsed.conflictStreak >= 0
    ) {
      return {
        preferredPort: parsed.preferredPort,
        fallbackPort: parsed.fallbackPort,
        conflictStreak: parsed.conflictStreak,
      }
    }
  } catch {
    // Fall through to fresh pool.
  }
  return null
}

export function writePortPool(dshHome: string, state: PortPoolState): void {
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(portPoolPath(dshHome), `${JSON.stringify(state, undefined, 2)}\n`)
}

export function portBindFailed(detail: string): boolean {
  return /EADDRINUSE|address already in use/i.test(detail)
}

function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('expected TCP address'))
        return
      }
      const chosen = address.port
      server.close((err) => {
        if (err) reject(err)
        else resolve(chosen)
      })
    })
  })
}

async function isFree(port: number): Promise<boolean> {
  try {
    return (await probePort(port)) === port
  } catch {
    return false
  }
}

/**
 * Stable Origin port pool:
 * - Always attempts `preferredPort` first; if free, resets `conflictStreak = 0`.
 * - Single transient collision uses `fallbackPort` (or ephemeral) WITHOUT clobbering `preferredPort`,
 *   preventing Chromium Origin drift from wiping localStorage.
 * - Only promotes a new `preferredPort` after 3 consecutive independent starts hit external occupancy.
 */
export async function acquireStablePort(
  dshHome: string,
  checkFree: (port: number) => Promise<boolean> = isFree,
  allocFresh: () => Promise<number> = () => probePort(0),
): Promise<{ readonly port: number; readonly state: PortPoolState; readonly usedFallback: boolean }> {
  const existing = readPortPool(dshHome)
  if (existing === null) {
    const preferred = await allocFresh()
    let fallback = await allocFresh()
    if (fallback === preferred) fallback = await allocFresh()
    const state: PortPoolState = { preferredPort: preferred, fallbackPort: fallback, conflictStreak: 0 }
    writePortPool(dshHome, state)
    return { port: preferred, state, usedFallback: false }
  }

  if (await checkFree(existing.preferredPort)) {
    const state: PortPoolState = { ...existing, conflictStreak: 0 }
    writePortPool(dshHome, state)
    return { port: existing.preferredPort, state, usedFallback: false }
  }

  const nextStreak = existing.conflictStreak + 1
  const candidate = (await checkFree(existing.fallbackPort))
    ? existing.fallbackPort
    : await allocFresh()

  if (nextStreak >= PROMOTE_CONFLICT_STREAK) {
    let nextFallback = await allocFresh()
    if (nextFallback === candidate) nextFallback = await allocFresh()
    const promoted: PortPoolState = {
      preferredPort: candidate,
      fallbackPort: nextFallback,
      conflictStreak: 0,
    }
    writePortPool(dshHome, promoted)
    return { port: candidate, state: promoted, usedFallback: true }
  }

  const kept: PortPoolState = {
    preferredPort: existing.preferredPort,
    fallbackPort: candidate,
    conflictStreak: nextStreak,
  }
  writePortPool(dshHome, kept)
  return { port: candidate, state: kept, usedFallback: true }
}
