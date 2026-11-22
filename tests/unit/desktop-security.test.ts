import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildWhitelistedHostEnv } from '../../templates/desktop/src/host/env-whitelist.js'
import { extractSafeTarGz } from '../../templates/desktop/src/host/safe-tar.js'
import { acquireStablePort } from '../../templates/desktop/src/host/port-pool.js'
import {
  ensureDualSlotProfile,
  handleSlotBootFailure,
  markSlotVerified,
  mergeCordisPatchYaml,
  recordSlotBootAttempt,
} from '../../templates/desktop/src/host/profile-slots.js'
import { redactSecrets } from '../../templates/desktop/src/host/redact.js'
import { exportRedactedDiagnosticBundle } from '../../templates/desktop/src/host/diagnostics.js'
import { packDeterministicTarGz } from '../../tools/builder/src/seed-builder.js'

describe('desktop security, tar safety, port pool, dual-slot rollback & diagnostic redaction', () => {
  it('enforces strict Host env whitelist while preserving proxies & CA certs', () => {
    const env = buildWhitelistedHostEnv({
      sourceEnv: {
        PATH: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        NODE_OPTIONS: '--require /evil.js',
        DEEPSEEK_API_KEY: 'sk-secret-123',
        OPENAI_API_KEY: 'sk-openai-456',
        DSH_HOME: '/wrong/home',
        OCTO_DEV: '1',
        HTTPS_PROXY: 'http://corp-proxy:8080',
        NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem',
      },
      platform: 'win32',
      dshHome: 'C:\\Users\\test\\AppData\\Roaming\\qinghe-bids\\h',
    })
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OCTO_DEV).toBeUndefined()
    expect(env.HTTPS_PROXY).toBe('http://corp-proxy:8080')
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\corp.pem')
    expect(env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(env.DSH_HOME).toContain('qinghe-bids')
  })

  it('rejects TAR path traversal, Windows reserved names, NTFS ADS & case collisions', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-tar-'))
    try {
      const makeRawTarGz = (name: string): Buffer => {
        const header = Buffer.alloc(512, 0)
        header.write(name, 0, 100, 'utf8')
        header.write('0000644\0', 100, 8, 'ascii')
        header.write('0000000\0', 108, 8, 'ascii')
        header.write('0000000\0', 116, 8, 'ascii')
        header.write('00000000004\0', 124, 12, 'ascii')
        header.write('00000000000\0', 136, 12, 'ascii')
        header.fill(0x20, 148, 156)
        header.write('0', 156, 1, 'ascii')
        header.write('ustar\0', 257, 6, 'ascii')
        header.write('00', 263, 2, 'ascii')
        let sum = 0
        for (let i = 0; i < 512; i += 1) sum += header[i]!
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
        const body = Buffer.alloc(512, 0)
        body.write('test', 0, 4, 'utf8')
        return require('node:zlib').gzipSync(Buffer.concat([header, body, Buffer.alloc(1024, 0)]))
      }

      for (const badName of ['../escape.txt', 'CON.txt', 'dir/file:ads.txt']) {
        const gz = makeRawTarGz(badName)
        const sha = createHash('sha256').update(gz).digest('hex')
        expect(() =>
          extractSafeTarGz({ archiveBuffer: gz, destDir: path.join(tmp, 'out'), expectedSha256: sha }),
        ).toThrow()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('keeps preferredPort stable on transient collisions and promotes only after 3 consecutive strikes', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-port-'))
    try {
      let nextFresh = 41000
      const alloc = async () => nextFresh++
      const r0 = await acquireStablePort(tmp, async () => true, alloc)
      expect(r0.port).toBe(41000)

      // Strike 1 & 2: preferredPort busy -> uses fallback WITHOUT changing preferredPort
      const r1 = await acquireStablePort(tmp, async (p) => p !== 41000, alloc)
      expect(r1.usedFallback).toBe(true)
      expect(r1.state.preferredPort).toBe(41000)
      expect(r1.state.conflictStreak).toBe(1)

      const r2 = await acquireStablePort(tmp, async (p) => p !== 41000, alloc)
      expect(r2.state.preferredPort).toBe(41000)
      expect(r2.state.conflictStreak).toBe(2)

      // Strike 3: promotes new preferredPort & resets streak
      const r3 = await acquireStablePort(tmp, async (p) => p !== 41000, alloc)
      expect(r3.state.preferredPort).toBe(r3.port)
      expect(r3.state.conflictStreak).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('merges cordis.patch.yml keys across slots & auto-rolls back after 2 failed boots on same runtime', () => {
    const merged = mergeCordisPatchYaml(
      '- id: ui-settings-general\n  config:\n    language: zh\n    welcomeNoticeVersion: "2025-01-01"\n',
      '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: "2026-09-28.1"\n',
    )
    expect(merged).toContain('language: zh')
    expect(merged).toContain('2026-09-28.1')

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-slot-'))
    try {
      const userData = path.join(tmp, 'userData')
      const dshHome = path.join(userData, 'h')

      const seed1 = packDeterministicTarGz([
        { name: 'package.json', content: Buffer.from('{"name":"p1","dependencies":{}}') },
        { name: 'cordis.patch.yml', content: Buffer.from('- id: session-log-deepseek\n  config:\n    enabled: false\n') },
      ])
      const hash1 = createHash('sha256').update(seed1).digest('hex')
      const seed1Path = path.join(tmp, 'seed1.tar.gz')
      writeFileSync(seed1Path, seed1)

      const prep1 = ensureDualSlotProfile({
        userDataDir: userData,
        dshHome,
        seedArchivePath: seed1Path,
        seedManifest: { schemaVersion: 1, target: 'win32-x64', seedHash: hash1, seedBytes: seed1.byteLength, maxEntryRelPath: 20, dshRuntimeVersion: '0.2.2-rc.5', managedBundles: [], builtAt: new Date().toISOString() },
      })
      markSlotVerified(userData, dshHome)
      expect(prep1.state.active).toBe(`p-${hash1.slice(0, 12)}`)

      // Upgrade to seed2 (different seedHash, same runtime)
      const seed2 = packDeterministicTarGz([
        { name: 'package.json', content: Buffer.from('{"name":"p2","dependencies":{}}') },
        { name: 'cordis.patch.yml', content: Buffer.from('- id: session-log-deepseek\n  config:\n    enabled: false\n') },
      ])
      const hash2 = createHash('sha256').update(seed2).digest('hex')
      const seed2Path = path.join(tmp, 'seed2.tar.gz')
      writeFileSync(seed2Path, seed2)

      const prep2 = ensureDualSlotProfile({
        userDataDir: userData,
        dshHome,
        seedArchivePath: seed2Path,
        seedManifest: { schemaVersion: 1, target: 'win32-x64', seedHash: hash2, seedBytes: seed2.byteLength, maxEntryRelPath: 20, dshRuntimeVersion: '0.2.2-rc.5', managedBundles: [], builtAt: new Date().toISOString() },
      })
      expect(prep2.upgraded).toBe(true)
      expect(prep2.state.previous).toBe(prep1.state.active)

      // Fail #1 -> retry; Fail #2 -> automatic rollback to slot 1!
      recordSlotBootAttempt(userData)
      expect(handleSlotBootFailure(userData, dshHome, '0.2.2-rc.5').action).toBe('retry')
      recordSlotBootAttempt(userData)
      const rb = handleSlotBootFailure(userData, dshHome, '0.2.2-rc.5')
      expect(rb.action).toBe('rolled_back')
      expect(rb.state?.active).toBe(prep1.state.active)
      expect(rb.state?.failedSlotHash).toBe(hash2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('redacts secrets and exports diagnostic bundle strictly excluding credentials & .env', () => {
    const raw = 'Authorization: Bearer secret_tok_999\nDEEPSEEK_API_KEY=sk-1234567890abcdef1234567890\nhttp://127.0.0.1:41000/?token=my_secret_token_abc\nDEBUG token=bare_tok_sensitive_777'
    const clean = redactSecrets(raw)
    expect(clean).not.toContain('secret_tok_999')
    expect(clean).not.toContain('sk-1234567890abcdef1234567890')
    expect(clean).not.toContain('my_secret_token_abc')
    expect(clean).not.toContain('bare_tok_sensitive_777')

    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-diag-'))
    try {
      const productDir = path.join(tmp, 'product')
      const userData = path.join(tmp, 'userData')
      mkdirSync(productDir, { recursive: true })
      mkdirSync(path.join(userData, 'logs'), { recursive: true })
      writeFileSync(path.join(productDir, 'product.json'), '{"ok":true}')
      writeFileSync(path.join(userData, '.credentials.yaml'), 'deepseek: sk-supersecret-9999999999')
      writeFileSync(path.join(userData, '.env'), 'OPENAI_API_KEY=sk-envsecret-8888888888')
      writeFileSync(path.join(userData, 'logs', 'host.log'), raw)

      const outZip = path.join(tmp, 'diag.zip')
      const res = exportRedactedDiagnosticBundle({ productDir, userDataDir: userData, outputZipPath: outZip })
      expect(existsSync(outZip)).toBe(true)
      const unpacked = unzipSync(readFileSync(outZip))
      expect(Object.keys(unpacked)).toContain('product/product.json')
      expect(Object.keys(unpacked)).toContain('logs/host.log')
      expect(Object.keys(unpacked).some((k) => k.includes('credentials') || k.includes('.env'))).toBe(false)
      const logContent = strFromU8(unpacked['logs/host.log']!)
      expect(logContent).not.toContain('sk-1234567890abcdef1234567890')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
