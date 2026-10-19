import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { generateKeyPairSync, X509Certificate, sign, constants } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Resolve the implementation used by SRT, including nested installations.
// No fixed npm release exists: the override pins the canonical DER fix from
// https://github.com/digitalbazaar/forge/pull/1159 at its immutable source revision.
const sandboxRequire = createRequire(require.resolve('@anthropic-ai/sandbox-runtime'))
// This transitive package has no bundled TS types; exercise its actual runtime API.
const forge = sandboxRequire('node-forge')
const message = 'Ouroboros dependency security regression'
const digest = forge.md.sha256.create().update(message).digest().getBytes()
const oid = Buffer.from('0609608648016503040201', 'hex')
const octets = Buffer.concat([Buffer.from([4, 32]), Buffer.from(digest, 'binary')])
const sequence = (bytes: Buffer, long = false) =>
  Buffer.concat([Buffer.from(long ? [0x30, 0x81, bytes.length] : [0x30, bytes.length]), bytes])
const digestInfo = (parameters: Buffer, innerLong = false, outerLong = false) =>
  sequence(
    Buffer.concat([sequence(Buffer.concat([oid, parameters]), innerLong), octets]),
    outerLong,
  ).toString('binary')
const canonical = digestInfo(Buffer.from([5, 0]))
const malformed = [
  ['extra inner child', digestInfo(Buffer.from([5, 0, 2, 1, 42]))],
  ['non-NULL parameters', digestInfo(Buffer.from([2, 1, 42]))],
  ['NULL carrying content', digestInfo(Buffer.from([5, 3, 1, 2, 3]))],
  ['non-minimal inner length', digestInfo(Buffer.from([5, 0]), true)],
  ['non-minimal outer length', digestInfo(Buffer.from([5, 0]), false, true)],
] as const

describe('sandbox RSA signature dependency', () => {
  for (const exponent of [3, 65537]) {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicExponent: exponent,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const publicKey = forge.pki.publicKeyFromPem(keys.publicKey)
    const privateKey = forge.pki.privateKeyFromPem(keys.privateKey)
    for (const [description, encoded] of malformed) {
      test(`rejects ${description} with exponent ${exponent}`, () => {
        // A private-key signature reproduces parser acceptance through normal
        // PKCS1 padding. No unsupported padding/parse flags are used.
        const signature = privateKey.sign(encoded, 'NONE')
        expect(() => publicKey.verify(digest, signature)).toThrow('DigestInfo')
      })
    }
    test(`preserves canonical and parameterless signatures with exponent ${exponent}`, () => {
      for (const encoded of [canonical, digestInfo(Buffer.alloc(0))]) {
        const signature = privateKey.sign(encoded, 'NONE')
        expect(publicKey.verify(digest, signature)).toBe(true)
        expect(publicKey.verify('wrong digest', signature)).toBe(false)
      }
      const nativeSignature = sign('sha256', Buffer.from(message), {
        key: keys.privateKey,
        padding: constants.RSA_PKCS1_PADDING,
      })
      expect(publicKey.verify(digest, nativeSignature.toString('binary'))).toBe(true)
      const pss = forge.pss.create({
        md: forge.md.sha256.create(),
        mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
        saltLength: 32,
      })
      const signature = privateKey.sign(forge.md.sha256.create().update(message), pss)
      expect(publicKey.verify(digest, signature, pss)).toBe(true)
    })
  }
  test('retains sandbox certificate generation, PEM parsing and Node TLS verification', () => {
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const certificate = forge.pki.createCertificate()
    certificate.publicKey = keys.publicKey
    certificate.serialNumber = '01'
    certificate.validity.notBefore = new Date(Date.now() - 60_000)
    certificate.validity.notAfter = new Date(Date.now() + 60_000)
    certificate.setSubject([{ name: 'commonName', value: 'Ouroboros test CA' }])
    certificate.setIssuer(certificate.subject.attributes)
    certificate.setExtensions([{ name: 'basicConstraints', cA: true }])
    certificate.sign(keys.privateKey, forge.md.sha256.create())
    const pem = forge.pki.certificateToPem(certificate)
    const restored = forge.pki.certificateFromPem(pem)
    expect(restored.verify(restored)).toBe(true)
    const native = new X509Certificate(pem)
    expect(native.verify(native.publicKey)).toBe(true)
  })
})

// Store-only ZIP fixtures: write mode bits explicitly to exercise symlinks.
function zip(entries: Array<{ name: string; text: string; mode?: number }>): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.text)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(Bun.hash.crc32(data), 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE((3 << 8) | 20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(Bun.hash.crc32(data), 16)
    directory.writeUInt32LE(data.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

describe('Electron archive dependency', () => {
  const electronRequire = createRequire(require.resolve('electron/package.json'))
  const { extract } = electronRequire('@electron-internal/extract-zip')
  test('extracts normal files and contained framework-style symlinks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ou-safe-zip-'))
    try {
      const file = join(dir, 'normal.zip')
      writeFileSync(
        file,
        zip([
          { name: 'version/target.txt', text: 'Electron fixture' },
          { name: 'current', text: 'version', mode: 0o120777 },
        ]),
      )
      await extract(file, { dir: join(dir, 'output') })
      expect(readFileSync(join(dir, 'output/version/target.txt'), 'utf8')).toBe('Electron fixture')
      if (process.platform !== 'win32') {
        expect(readFileSync(join(dir, 'output/current/target.txt'), 'utf8')).toBe(
          'Electron fixture',
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test.each(['traversal', 'symlink'])('rejects %s outside the extraction root', async (attack) => {
    const dir = mkdtempSync(join(tmpdir(), 'ou-unsafe-zip-'))
    try {
      const file = join(dir, 'attack.zip')
      writeFileSync(
        file,
        zip(
          attack === 'traversal'
            ? [{ name: '../escaped.txt', text: 'escaped' }]
            : [
                { name: 'escape', text: '..', mode: 0o120777 },
                { name: 'escape/escaped.txt', text: 'escaped' },
              ],
        ),
      )
      await expect(extract(file, { dir: join(dir, 'output') })).rejects.toThrow()
      expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('rejects a Unicode alias that hides a pending symlink escape', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'ou-unicode-zip-'))
    try {
      const file = join(dir, 'unicode.zip')
      writeFileSync(join(dir, 'outside'), 'outside-root marker')
      writeFileSync(
        file,
        zip([
          { name: 'escape', text: 'a/ς/../outside', mode: 0o120777 },
          { name: 'a/Σ', text: '..', mode: 0o120777 },
        ]),
      )
      await expect(extract(file, { dir: join(dir, 'output') })).rejects.toThrow()
      expect(existsSync(join(dir, 'output/escape'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('never writes through a Unicode alias outside the extraction root', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'ou-unicode-write-'))
    try {
      const file = join(dir, 'unicode-write.zip')
      mkdirSync(join(dir, 'outside'))
      writeFileSync(join(dir, 'outside/payload'), 'original')
      writeFileSync(
        file,
        zip([
          // Keep the reviewed order: the native extractor must queue files
          // before creating either in-archive symlink.
          { name: 'escape', text: 'a/ς/../outside', mode: 0o120777 },
          { name: 'a/Σ', text: '..', mode: 0o120777 },
          { name: 'escape/payload', text: 'overwritten' },
          { name: 'escape/new-payload', text: 'created outside' },
        ]),
      )
      await expect(extract(file, { dir: join(dir, 'output') })).rejects.toThrow()
      expect(readFileSync(join(dir, 'outside/payload'), 'utf8')).toBe('original')
      expect(existsSync(join(dir, 'outside/new-payload'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('never writes through a pre-existing symlink outside the extraction root', async () => {
    if (process.platform === 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'ou-existing-link-'))
    try {
      const file = join(dir, 'pre-existing-link.zip')
      const output = join(dir, 'output')
      mkdirSync(join(dir, 'outside'))
      mkdirSync(output)
      symlinkSync(join(dir, 'outside'), join(output, 'escape'))
      writeFileSync(join(dir, 'outside/payload'), 'original')
      writeFileSync(
        file,
        zip([
          { name: 'escape/payload', text: 'overwritten' },
          { name: 'escape/new-payload', text: 'created outside' },
        ]),
      )
      await expect(extract(file, { dir: output })).rejects.toThrow()
      expect(readFileSync(join(dir, 'outside/payload'), 'utf8')).toBe('original')
      expect(existsSync(join(dir, 'outside/new-payload'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
