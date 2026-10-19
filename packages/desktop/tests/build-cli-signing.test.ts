import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(join(import.meta.dir, '../scripts/build-cli.sh'), 'utf8')

test('desktop CLI build routes native and cross-architecture binaries through the signing helper', () => {
  expect(script).not.toContain('bun build --compile')
  expect(script).toContain('bun scripts/build.ts dist/ouroboros')
  expect(script).toContain('bun scripts/build.ts "$OUT_DIR/ouroboros-darwin-x64" bun-darwin-x64')
  expect(script).toContain('bun scripts/build.ts "$OUT_DIR/ouroboros-darwin-arm64" bun-darwin-arm64')
  expect(script).toContain('codesign --verify --verbose=2 "$OUT_DIR/ouroboros-darwin-arm64"')
  expect(script).toContain('codesign --verify --verbose=2 "$OUT_DIR/ouroboros-darwin-x64"')
})
