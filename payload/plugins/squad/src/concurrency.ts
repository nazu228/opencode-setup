export class Semaphore {
  private active = 0
  private currentLimit: number
  private readonly waiters: (() => void)[] = []

  constructor(limit: number) {
    this.currentLimit = clampLimit(limit)
  }

  get limit(): number {
    return this.currentLimit
  }

  setLimit(limit: number): void {
    this.currentLimit = clampLimit(limit)
    this.drain()
  }

  async acquire(): Promise<void> {
    if (this.active < this.currentLimit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  async withSlot<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await action()
    } finally {
      this.release()
    }
  }

  private drain(): void {
    while (this.active < this.currentLimit && this.waiters.length) {
      const next = this.waiters.shift()
      if (!next) return
      this.active++
      next()
    }
  }
}

function clampLimit(limit: number): number {
  const value = Number.isFinite(limit) ? Math.floor(limit) : 2
  return Math.max(1, Math.min(12, value || 2))
}

export const globalBuildSemaphore = new Semaphore(2)
const requestedBuildLimits = new Map<number, number>()

function refreshGlobalBuildLimit(): void {
  const limits = [...requestedBuildLimits.keys()]
  globalBuildSemaphore.setLimit(limits.length ? Math.max(2, ...limits) : 2)
}

export function configureGlobalBuildConcurrency(limit: number): Semaphore {
  const value = clampLimit(limit)
  requestedBuildLimits.set(value, (requestedBuildLimits.get(value) ?? 0) + 1)
  refreshGlobalBuildLimit()
  return globalBuildSemaphore
}

export function releaseGlobalBuildConcurrency(limit: number): void {
  const value = clampLimit(limit)
  const count = requestedBuildLimits.get(value) ?? 0
  if (count <= 1) requestedBuildLimits.delete(value)
  else requestedBuildLimits.set(value, count - 1)
  refreshGlobalBuildLimit()
}
