import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  DESKTOP_CONFIG_VERSION,
  loadConfig,
  migrateDesktopConfig,
  readOuroborosFile,
  writeOuroborosFile,
} from '@src/config'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `ouroboros-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Load the default config, then apply the desktop migration in one step. */
function loadAndMigrate(dir: string) {
  const loaded = loadConfig(dir)
  if (!loaded.ok) throw loaded.error
  return migrateDesktopConfig(dir, loaded.value)
}

describe('migrateDesktopConfig', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = makeTempDir()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('lifts tier3 and stamps the version on an old desktop config', () => {
    // Simulate an already-installed app: explicit tier3:false, no version marker.
    writeOuroborosFile(tempDir, {
      permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
    })

    const migrated = loadAndMigrate(tempDir)
    expect(migrated.permissions.tier3).toBe(true)
    expect(migrated._ouroborosConfigVersion).toBe(DESKTOP_CONFIG_VERSION)

    // The change is persisted to disk.
    const raw = readOuroborosFile(tempDir)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return
    expect((raw.value.permissions as { tier3?: boolean }).tier3).toBe(true)
    expect(raw.value._ouroborosConfigVersion).toBe(DESKTOP_CONFIG_VERSION)
  })

  test('a freshly-loaded config (no file) gets tier3 enabled and is persisted', () => {
    const migrated = loadAndMigrate(tempDir)
    expect(migrated.permissions.tier3).toBe(true)

    const raw = readOuroborosFile(tempDir)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return
    expect((raw.value.permissions as { tier3?: boolean }).tier3).toBe(true)
    expect(raw.value._ouroborosConfigVersion).toBe(DESKTOP_CONFIG_VERSION)
  })

  test('does not re-enable tier3 once the version is stamped', () => {
    // A user who deliberately disabled tier3 AFTER the migration ran.
    writeOuroborosFile(tempDir, {
      permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
      _ouroborosConfigVersion: DESKTOP_CONFIG_VERSION,
    })

    const migrated = loadAndMigrate(tempDir)
    expect(migrated.permissions.tier3).toBe(false)

    const raw = readOuroborosFile(tempDir)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return
    expect((raw.value.permissions as { tier3?: boolean }).tier3).toBe(false)
  })

  test('preserves unrelated on-disk fields', () => {
    writeOuroborosFile(tempDir, {
      permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
      disabledSkills: ['some-skill'],
    })

    loadAndMigrate(tempDir)

    const raw = readOuroborosFile(tempDir)
    expect(raw.ok).toBe(true)
    if (!raw.ok) return
    expect(raw.value.disabledSkills).toEqual(['some-skill'])
    expect((raw.value.permissions as { tier3?: boolean }).tier3).toBe(true)
  })

  test('is idempotent: a second run does not change the file', () => {
    writeOuroborosFile(tempDir, {
      permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
    })

    loadAndMigrate(tempDir)
    const afterFirst = readOuroborosFile(tempDir)

    loadAndMigrate(tempDir)
    const afterSecond = readOuroborosFile(tempDir)

    expect(afterFirst.ok && afterSecond.ok).toBe(true)
    if (!afterFirst.ok || !afterSecond.ok) return
    expect(afterSecond.value).toEqual(afterFirst.value)
  })

  test('loadConfig reads tier3:true after migration (round-trips through the schema)', () => {
    writeOuroborosFile(tempDir, {
      permissions: { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false },
    })

    loadAndMigrate(tempDir)

    const reloaded = loadConfig(tempDir)
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    expect(reloaded.value.permissions.tier3).toBe(true)
  })
})
