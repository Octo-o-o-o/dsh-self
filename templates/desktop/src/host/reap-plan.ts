export const IDENTITY_TOLERANCE_MS = 2_000

export interface ProcessFact {
  readonly pid: number
  readonly parentPid: number
  readonly createdAtMs: number
}

export interface ReapPlan {
  readonly action: 'kill' | 'skip-pid-reused' | 'skip-root-alive' | 'skip-unverified' | 'none'
  readonly victims: readonly number[]
}

export interface PlanCleanupInput {
  readonly hostPid: number
  readonly hostCreatedAtMs: number
  readonly observedAtMs: number
  readonly processes: readonly ProcessFact[]
  readonly rootExpected: 'alive' | 'dead'
  readonly creationKnown: boolean
  readonly toleranceMs?: number
}

function within(value: number, start: number, end: number): boolean {
  return value >= start && value <= end
}

export function planProcessCleanup(input: PlanCleanupInput): ReapPlan {
  const tolerance = input.toleranceMs ?? IDENTITY_TOLERANCE_MS
  const host = input.processes.find((row) => row.pid === input.hostPid)
  if (host !== undefined) {
    const sameProcess = input.creationKnown && Math.abs(host.createdAtMs - input.hostCreatedAtMs) <= tolerance
    if (!input.creationKnown && input.rootExpected === 'dead') return { action: 'skip-unverified', victims: [] }
    if (input.creationKnown && !sameProcess) return { action: 'skip-pid-reused', victims: [] }
    if (input.rootExpected === 'dead') return { action: 'skip-root-alive', victims: [] }
    const earliest = input.creationKnown ? input.hostCreatedAtMs - tolerance : Number.NEGATIVE_INFINITY
    const latest = input.observedAtMs + tolerance
    const victims = input.processes
      .filter((row) => row.pid !== input.hostPid && row.pid > 4 && row.parentPid === input.hostPid && within(row.createdAtMs, earliest, latest))
      .map((row) => row.pid)
    return { action: victims.length > 0 ? 'kill' : 'none', victims }
  }
  if (input.rootExpected === 'alive') return { action: 'skip-unverified', victims: [] }
  if (!input.creationKnown || input.hostCreatedAtMs <= 0) return { action: 'skip-unverified', victims: [] }
  const earliest = input.hostCreatedAtMs - tolerance
  const latest = input.observedAtMs + tolerance
  const victims = input.processes
    .filter((row) => row.pid > 4 && row.parentPid === input.hostPid && within(row.createdAtMs, earliest, latest))
    .map((row) => row.pid)
  return { action: victims.length > 0 ? 'kill' : 'none', victims }
}
