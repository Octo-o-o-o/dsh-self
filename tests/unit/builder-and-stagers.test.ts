import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDarwinInsideOutCodesignOrder,
  buildProfileSeed,
  generateParameterizedNsisInclude,
  generateProductIcons,
  stageDarwinAppBundle,
  stageLinuxDebPackage,
  validateAndSnapshotInputs,
} from '../../tools/builder/src/index.js'

describe('tools/builder icons, deterministic seed, NSIS guards & M5 Linux/macOS stagers', () => {
  it('generates valid multi-size .ico, .icns & PNG icons from product brand icon', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-icons-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const icons = await generateProductIcons({ spec: snap.spec, outDir: path.join(tmp, 'icons') })
      const ico = readFileSync(icons.icoPath)
      expect(ico.readUInt16LE(0)).toBe(0)
      expect(ico.readUInt16LE(2)).toBe(1) // ICON header
      expect(ico.readUInt16LE(4)).toBe(6) // 6 sizes embedded

      const icns = readFileSync(icons.icnsPath)
      expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
      expect(existsSync(icons.png256Path)).toBe(true)
      expect(existsSync(path.join(icons.linuxIconsDir, '512x512.png'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('produces deterministic profile-seed.tar.gz with seed-level telemetry off & welcomeNoticeVersion', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-seed-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const s1 = buildProfileSeed({ spec: snap.spec, lock: snap.lock, outDir: path.join(tmp, 'out1') })
      const s2 = buildProfileSeed({ spec: snap.spec, lock: snap.lock, outDir: path.join(tmp, 'out2') })
      expect(s1.manifest.seedHash).toBe(s2.manifest.seedHash)
      expect(s1.manifest.managedBundles).toContain('dsh-theme-product')
      expect(s1.manifest.managedBundles).toContain('dsh-shell-product')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('generates hardened NSIS include closing all 4 app-builder-lib@26.18.0 traps', () => {
    const spec = JSON.parse(readFileSync(path.resolve('fixtures/qinghe-bids/product.json'), 'utf8'))
    const nsh = generateParameterizedNsisInclude(spec)
    expect(nsh).toContain('!macro customInit')
    expect(nsh).toContain('ReadRegStr $DshOldStartMenuLink HKCU')
    expect(nsh).toContain('SetErrorLevel 1638')
    expect(nsh).toContain('resources\\runtime\\node\\node.exe')
    expect(nsh).toContain('StrCpy $launchLink "$DshFinalStartMenuLink"')
    expect(nsh).toContain('WriteRegStr HKCU')
    expect(nsh).toContain('DshSelfShortcutPath')
    expect(nsh).toContain('!macro customUnInstall')
  })

  it('stages M5 Linux .deb (/opt/<slug>, desktopName=<slug>) & macOS ASCII .app + inside-out codesign', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-m5-'))
    try {
      const linuxSnap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.linux-x64.lock.json'),
        target: 'linux-x64',
        snapshotDir: path.join(tmp, 'snap-linux'),
      })
      const { plan: linuxPlan, receipt: linuxReceipt } = await stageLinuxDebPackage({
        snapshot: linuxSnap,
        outDir: path.join(tmp, 'out-linux'),
        jobId: 'job-linux-test',
      })
      expect(linuxPlan.installPrefix).toBe(`/opt/${linuxSnap.spec.identity.internalSlug}`)
      expect(linuxPlan.desktopName).toBe(linuxSnap.spec.identity.internalSlug)
      expect(linuxPlan.desktopEntryContent).toContain(`Exec=/opt/${linuxSnap.spec.identity.internalSlug}/${linuxSnap.spec.identity.internalSlug}`)
      expect(linuxReceipt.target).toBe('linux-x64')

      const macSnap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.darwin-arm64.lock.json'),
        target: 'darwin-arm64',
        snapshotDir: path.join(tmp, 'snap-mac'),
      })
      const { plan: macPlan, receipt: macReceipt } = await stageDarwinAppBundle({
        snapshot: macSnap,
        target: 'darwin-arm64',
        outDir: path.join(tmp, 'out-mac'),
        jobId: 'job-mac-test',
      })
      expect(macPlan.appBundleName).toBe(`${macSnap.spec.identity.internalSlug}.app`)
      expect(macPlan.helperNames.length).toBe(4)
      expect(macPlan.localizationFiles).toContain('Resources/zh_CN.lproj/InfoPlist.strings')
      const order = buildDarwinInsideOutCodesignOrder(macSnap.spec.identity.internalSlug)
      expect(order[order.length - 1]).toBe(`${macSnap.spec.identity.internalSlug}.app`)
      expect(macReceipt.target).toBe('darwin-arm64')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
