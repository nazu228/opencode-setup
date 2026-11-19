import { readFile, stat } from "node:fs/promises"
import path from "node:path"

const MAX_TEST_SCAN_BYTES = 256 * 1024

const INLINE_TEST_PATTERNS = [
  /#\[cfg\(test\)\]/,
  /#\[test\]/,
  /\bfunc\s+Test[A-Za-z0-9_]*\s*\(/,
  /\*testing\.T\b/,
  /\bdef\s+test_[A-Za-z0-9_]*\s*\(/,
  /\bimport\s+pytest\b/,
  /\bunittest\b/,
  /@Test\b/,
  /org\.junit/,
  /\bvoid\s+test[A-Z][A-Za-z0-9_]*\s*\(/,
]

export function isTestFile(file: string): boolean {
  const value = file.replace(/\\/g, "/")
  if (/(^|\/)(tests?|__tests__)\//i.test(value)) return true
  if (/\.(test|spec)\.[^/]+$/i.test(value)) return true
  if (/_test\.[^/]+$/i.test(value)) return true
  if (/(^|\/)test_[^/]+\.py$/i.test(value)) return true
  if (/(^|\/)[^/]*(Test|Tests|IT)\.(java|kt|kts|cs)$/i.test(value)) return true
  return false
}

export async function hasTestFiles(worktree: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    if (isTestFile(file)) return true
    const full = path.join(worktree, file)
    try {
      const info = await stat(full)
      if (!info.isFile() || info.size > MAX_TEST_SCAN_BYTES) continue
      const text = await readFile(full, "utf8")
      if (INLINE_TEST_PATTERNS.some((pattern) => pattern.test(text))) return true
    } catch {
      // Deleted or unreadable files cannot prove the presence of tests.
    }
  }
  return false
}
