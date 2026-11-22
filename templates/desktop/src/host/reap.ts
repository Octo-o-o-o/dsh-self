import { forceKillTree } from './stop.js'
import { listProcesses } from './process-snapshot.js'
import { IDENTITY_TOLERANCE_MS, planProcessCleanup, type ReapPlan } from './reap-plan.js'

export interface HostIdentity {
  readonly pid: number
  readonly createdAtMs: number
}

async function killVictims(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) continue
    await forceKillTree(pid)
  }
}

export async function endVerifiedChildTrees(rootPid: number, rootCreatedAtMs: number | undefined): Promise<ReapPlan> {
  const processes = await listProcesses()
  const plan = planProcessCleanup({
    hostPid: rootPid,
    hostCreatedAtMs: rootCreatedAtMs ?? 0,
    observedAtMs: Date.now(),
    processes,
    rootExpected: 'alive',
    creationKnown: rootCreatedAtMs !== undefined && rootCreatedAtMs > 0,
  })
  if (plan.action === 'kill') await killVictims(plan.victims)
  return plan
}

export async function reapVerifiedOrphans(identity: HostIdentity, observedAtMs = Date.now()): Promise<ReapPlan> {
  const processes = await listProcesses()
  const plan = planProcessCleanup({
    hostPid: identity.pid,
    hostCreatedAtMs: identity.createdAtMs,
    observedAtMs,
    processes,
    rootExpected: 'dead',
    creationKnown: identity.createdAtMs > 0,
  })
  if (plan.action === 'kill') await killVictims(plan.victims)
  return plan
}

/** Cold-start recovery: reap any stale Host recorded in `host-pids.json` whose PID + creationTime still match. */
export async function reapStaleRecordedHosts(records: readonly HostIdentity[]): Promise<number[]> {
  if (records.length === 0) return []
  const processes = await listProcesses()
  const reaped: number[] = []
  for (const record of records) {
    if (record.createdAtMs <= 0) continue
    const live = processes.find((p) => p.pid === record.pid)
    if (live !== undefined && Math.abs(live.createdAtMs - record.createdAtMs) <= IDENTITY_TOLERANCE_MS) {
      await forceKillTree(record.pid)
      reaped.push(record.pid)
    } else if (live === undefined) {
      const orphanPlan = await reapVerifiedOrphans(record)
      if (orphanPlan.victims.length > 0) reaped.push(...orphanPlan.victims)
    }
  }
  return reaped
}
