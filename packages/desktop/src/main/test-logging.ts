import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { TEST_BOOT_LOG_PATH } from './test-paths'

export function writeTestLog(message: string): void {
  const logPath = process.env.OUROBOROS_TEST_BOOT_LOG_PATH ?? (
    process.env.NODE_ENV === 'test' ? TEST_BOOT_LOG_PATH : undefined
  )
  if (!logPath) return

  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
}
