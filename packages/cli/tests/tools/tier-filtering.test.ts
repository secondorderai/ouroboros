import { describe, test, expect } from 'bun:test'
import { createRegistry } from '@src/tools/registry'

/**
 * The desktop's empty-memory bug was caused by the `memory` tool being tier 3
 * while the shipped config had tier3 disabled — the agent's tier filter then
 * removed the tool entirely. These tests pin the tier and the gating so the fix
 * (enabling tier 3 for the desktop) keeps making the tool available.
 */
describe('tier filtering of the memory tool', () => {
  const enabled = { tier0: true, tier1: true, tier2: true, tier3: true, tier4: false }
  const tier3Off = { tier0: true, tier1: true, tier2: true, tier3: false, tier4: false }

  test('the memory tool is tier 3', async () => {
    const registry = await createRegistry()
    expect(registry.getToolTier('memory')).toBe(3)
  })

  test('memory is disabled when tier3 is off', async () => {
    const registry = await createRegistry()
    expect(registry.toolsDisabledByTier(tier3Off)).toContain('memory')
  })

  test('memory is available when tier3 is on', async () => {
    const registry = await createRegistry()
    expect(registry.toolsDisabledByTier(enabled)).not.toContain('memory')
  })
})
