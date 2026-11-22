export interface OrphanExit {
  noteDisconnect(): void
  disarm(): void
  readonly pending: boolean
}

export interface OrphanExitOptions {
  readonly timeoutMs: number
  onFire(): void
  schedule?(fire: () => void, timeoutMs: number): { cancel(): void }
}

function defaultSchedule(fire: () => void, timeoutMs: number): { cancel(): void } {
  const timer = setTimeout(fire, timeoutMs)
  return { cancel: () => { clearTimeout(timer) } }
}

export function createOrphanExit(options: OrphanExitOptions): OrphanExit {
  const schedule = options.schedule ?? defaultSchedule
  let timer: { cancel(): void } | undefined
  let token = 0
  return {
    get pending() { return timer !== undefined },
    noteDisconnect() {
      if (timer !== undefined) return
      const scheduled = ++token
      timer = schedule(() => {
        if (scheduled !== token) return
        timer = undefined
        options.onFire()
      }, options.timeoutMs)
    },
    disarm() {
      token += 1
      timer?.cancel()
      timer = undefined
    },
  }
}
