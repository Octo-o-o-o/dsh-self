import { readdirSync, readFileSync } from 'node:fs'
import { REAP_ENUM_TIMEOUT_MS } from '../identity.js'
import { captureBounded } from './bounded-exec.js'
import type { ProcessFact } from './reap-plan.js'

export interface ProcessSnapshot extends ProcessFact {}

function parseRows(text: string): ProcessSnapshot[] {
  const rows: ProcessSnapshot[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+),(\d+),(\d+)$/)
    if (match === null) continue
    const pid = Number(match[1])
    const parentPid = Number(match[2])
    const createdAtMs = Number(match[3])
    if (pid <= 0 || parentPid < 0 || !Number.isFinite(createdAtMs)) continue
    rows.push({ pid, parentPid, createdAtMs })
  }
  return rows
}

function windowsScript(pid?: number): string {
  const filter = pid === undefined ? '' : `-Filter "ProcessId = ${pid}" `
  return [
    `$rows = Get-CimInstance Win32_Process ${filter}| Select-Object ProcessId, ParentProcessId, CreationDate`,
    'foreach ($row in $rows) {',
    '  if ($null -eq $row.CreationDate) { continue }',
    '  $ms = ([DateTimeOffset]::new($row.CreationDate)).ToUnixTimeMilliseconds()',
    '  "{0},{1},{2}" -f [int]$row.ProcessId, [int]$row.ParentProcessId, $ms',
    '}',
  ].join('\n')
}

function linuxSnapshots(): ProcessSnapshot[] {
  let btime = 0
  try {
    const stat = readFileSync('/proc/stat', 'utf8')
    const match = stat.match(/^btime\s+(\d+)/m)
    if (match?.[1] !== undefined) btime = Number(match[1])
  } catch {
    return []
  }
  if (btime <= 0) return []
  const rows: ProcessSnapshot[] = []
  let names: string[]
  try { names = readdirSync('/proc') } catch { return [] }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const text = readFileSync(`/proc/${name}/stat`, 'utf8')
      const end = text.lastIndexOf(')')
      if (end < 0) continue
      const rest = text.slice(end + 2).split(' ')
      const parentPid = Number(rest[1])
      const startTicks = Number(rest[19])
      if (!Number.isInteger(parentPid) || !Number.isFinite(startTicks)) continue
      rows.push({
        pid: Number(name),
        parentPid,
        createdAtMs: Math.round(btime * 1000 + (startTicks / 100) * 1000),
      })
    } catch { /* exited */ }
  }
  return rows
}

async function darwinSnapshots(): Promise<ProcessSnapshot[]> {
  const result = await captureBounded('ps', ['-ax', '-o', 'pid=,ppid=,lstart='], REAP_ENUM_TIMEOUT_MS, 16 * 1024 * 1024)
  if (result.timedOut || result.stdout.length === 0) return []
  const rows: ProcessSnapshot[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match?.[1] || !match[2] || !match[3]) continue
    const created = Date.parse(match[3])
    if (!Number.isFinite(created)) continue
    rows.push({ pid: Number(match[1]), parentPid: Number(match[2]), createdAtMs: created })
  }
  return rows
}

export async function listProcesses(pid?: number): Promise<ProcessSnapshot[]> {
  if (!Number.isInteger(pid) && pid !== undefined) return []
  if (process.platform === 'win32') {
    const res = await captureBounded('powershell.exe', ['-NoProfile', '-Command', windowsScript(pid)], REAP_ENUM_TIMEOUT_MS, 16 * 1024 * 1024)
    return parseRows(res.stdout)
  }
  if (process.platform === 'linux') {
    const rows = linuxSnapshots()
    return pid === undefined ? rows : rows.filter((row) => row.pid === pid)
  }
  if (process.platform === 'darwin') {
    const rows = await darwinSnapshots()
    return pid === undefined ? rows : rows.filter((row) => row.pid === pid)
  }
  return []
}

export async function readProcessCreationTime(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const rows = await listProcesses(pid)
  return rows.find((row) => row.pid === pid)?.createdAtMs
}
