import { mkdir, open, stat, unlink } from "node:fs/promises"
import path from "node:path"
import { nowIso } from "./metrics.ts"

export interface FileLockOptions {
  staleMs?: number
  retries?: number
  delayMs?: number
  label?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs > staleMs
  } catch {
    return false
  }
}

export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? 30_000
  const retries = options.retries ?? 200
  const delayMs = options.delayMs ?? 25
  const label = options.label ?? path.basename(lockPath)
  await mkdir(path.dirname(lockPath), { recursive: true })

  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      handle = await open(lockPath, "wx")
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, ts: nowIso() })}\n`, "utf8")
      break
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined)
        await unlink(lockPath).catch(() => undefined)
        handle = undefined
      }
      const code = (error as { code?: string })?.code
      if (code !== "EEXIST") throw error
      if (await lockIsStale(lockPath, staleMs)) {
        await unlink(lockPath).catch(() => undefined)
        continue
      }
      await sleep(delayMs)
    }
  }
  if (!handle) {
    throw new Error(`Не удалось получить lock "${label}" за ${Math.round((retries * delayMs) / 1000)}s.`)
  }
  try {
    return await action()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}
