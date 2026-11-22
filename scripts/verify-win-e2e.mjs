/**
 * Real Windows x64 end-to-end packaging, installation, coexistence, same-name disambiguation,
 * rename-upgrade, dual-slot seedHash switch, NSIS downgrade block, diagnostic redaction & clean uninstall verifier.
 *
 * Pass `--skip-build` to reuse freshly built `.dev/win-e2e/builds/*` installers.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync, strFromU8 } from 'fflate'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseShellDir = path.join(root, '.dev', 'base-shell', 'win32-x64')
const e2eRoot = path.join(root, '.dev', 'win-e2e')
const buildsRoot = path.join(e2eRoot, 'builds')
const installRoot = path.join(e2eRoot, 'installed')
const builderCli = path.join(root, 'tools', 'builder', 'dist', 'cli.js')
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const skipBuild = process.argv.includes('--skip-build')

const builderMod = await import(pathToFileURL(path.join(root, 'tools', 'builder', 'dist', 'index.js')).href)

function assert(cond, msg) {
  if (!cond) throw new Error(`WIN-E2E ASSERTION FAILED: ${msg}`)
}

function readFixtureSpec(name) {
  return JSON.parse(readFileSync(path.join(root, 'fixtures', name, 'product.json'), 'utf8'))
}

/** Run NSIS installer/uninstaller cleanly via Windows Start-Process (avoids pipe-handle inheritance & preserves unquoted /D=...). */
function runNsisSilent(exePath, installDir, { allowNonZero = false, timeoutMs = 360_000 } = {}) {
  const started = Date.now()
  const argLine = installDir ? `/S /D=${installDir}` : '/S'
  console.log(`[win-e2e] Running NSIS: ${path.basename(exePath)} ${argLine}`)
  const psScript = `$p = Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -ArgumentList '${argLine.replace(/'/g, "''")}' -Wait -PassThru; exit $p.ExitCode`
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: timeoutMs,
  })
  const code = res.status ?? (res.error ? 99 : 1)
  console.log(`[win-e2e] NSIS finished (code=${code}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (code !== 0 && !allowNonZero) {
    throw new Error(`NSIS command failed (code=${code}, err=${res.error?.message ?? 'none'}): ${exePath} ${argLine}`)
  }
  return { code }
}

/** Read HKCU registry string as exact UTF-8 Unicode (avoids Windows OEM codepage-936 mojibake on Chinese paths). */
function readRegValue(guid, valueName) {
  try {
    const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $v = Get-ItemPropertyValue -Path 'HKCU:\\Software\\${guid}' -Name '${valueName}' -ErrorAction Stop; [Console]::Out.Write($v)`
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

async function buildOrLoadFixture(name) {
  const outDir = path.join(buildsRoot, name)
  const receiptPath = path.join(outDir, 'build-receipt.json')
  if (skipBuild && existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    assert(existsSync(receipt.artifactPath), `Cached installer missing: ${receipt.artifactPath}`)
    assert(builderMod.sha256File(receipt.artifactPath) === receipt.artifactSha256, `SHA-256 mismatch for ${name}`)
    console.log(`[win-e2e] Using verified built installer for ${name}: ${path.basename(receipt.artifactPath)} (${(receipt.artifactBytes / 1024 / 1024).toFixed(1)} MB)`)
    return { receipt, elapsedMs: 0 }
  }
  const started = Date.now()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const productPath = path.join(root, 'fixtures', name, 'product.json')
  const lockPath = path.join(root, 'fixtures', name, 'locks', 'plugins.win32-x64.lock.json')
  execFileSync(
    process.execPath,
    [
      builderCli,
      '--product', productPath,
      '--lock', lockPath,
      '--target', 'win32-x64',
      '--base-shell', baseShellDir,
      '--out', outDir,
      '--job-id', `win-e2e-${name}`,
    ],
    { stdio: 'inherit', windowsHide: true },
  )
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  assert(existsSync(receipt.artifactPath), `Installer missing: ${receipt.artifactPath}`)
  assert(builderMod.sha256File(receipt.artifactPath) === receipt.artifactSha256, `SHA-256 mismatch for ${name}`)
  const elapsedSec = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`[win-e2e] Built ${name} in ${elapsedSec}s (${(receipt.artifactBytes / 1024 / 1024).toFixed(1)} MB)`)
  return { receipt, elapsedMs: Date.now() - started }
}

async function smokeLaunchInstalledExe(exePath, reportPath, extraEnv = {}) {
  rmSync(reportPath, { force: true })
  const started = Date.now()
  await new Promise((resolve, reject) => {
    const child = spawn(exePath, [], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        DSH_SELF_SMOKE_HEADLESS: '1',
        DSH_SELF_SMOKE_REPORT_FILE: reportPath,
        ...extraEnv,
      },
    })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`Smoke launch timed out after 95s: ${exePath}`))
    }, 95_000)
    child.once('error', (err) => { clearTimeout(timer); reject(err) })
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  assert(existsSync(reportPath), `Smoke report not written: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  // Verify zero orphan Host child process after Electron exits
  if (typeof report.hostPid === 'number' && report.hostPid > 0) {
    await new Promise((r) => setTimeout(r, 800))
    let alive = false
    try { process.kill(report.hostPid, 0); alive = true } catch { alive = false }
    assert(!alive, `Orphan Host process still alive after app quit! pid=${report.hostPid}`)
  }
  return { ...report, elapsedMs: Date.now() - started }
}

function findUninstaller(instDir) {
  if (!existsSync(instDir)) return null
  const hit = readdirSync(instDir).find((f) => /^Uninstall.*\.exe$/i.test(f))
  return hit ? path.join(instDir, hit) : null
}

function cleanTestInstallState(slugs) {
  const guids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]
  for (const instName of ['bids', 'design', 'bids-dup']) {
    const dir = path.join(installRoot, instName)
    try {
      const uninst = findUninstaller(dir)
      if (uninst) runNsisSilent(uninst, undefined, { allowNonZero: true, timeoutMs: 45_000 })
    } catch { /* ignore */ }
  }
  for (const guid of guids) {
    const sm = readRegValue(guid, 'DshSelfShortcutPath')
    const dk = readRegValue(guid, 'DshSelfDesktopLink')
    if (sm && existsSync(sm)) rmSync(sm, { force: true })
    if (dk && existsSync(dk)) rmSync(dk, { force: true })
    spawnSync('reg.exe', ['delete', `HKCU\\Software\\${guid}`, '/f'], { stdio: 'ignore', windowsHide: true })
  }
  for (const slug of slugs) {
    try { rmSync(path.join(appData, slug), { recursive: true, force: true }) } catch { /* ignore */ }
  }
  try { rmSync(installRoot, { recursive: true, force: true }) } catch { /* ignore */ }
}

async function main() {
  const bidsSpec = readFixtureSpec('qinghe-bids')
  const designSpec = readFixtureSpec('qinghe-design')
  const dupSpec = readFixtureSpec('qinghe-bids-dup')
  const bidsSlug = bidsSpec.identity.internalSlug
  const designSlug = designSpec.identity.internalSlug
  const dupSlug = dupSpec.identity.internalSlug
  const allSlugs = [bidsSlug, designSlug, dupSlug]

  cleanTestInstallState(allSlugs)
  mkdirSync(buildsRoot, { recursive: true })
  mkdirSync(installRoot, { recursive: true })

  const summary = { builds: {}, checks: {} }

  try {
    console.log('\n=== PHASE A: Verify / Build 5 Real Windows x64 NSIS Installers ===')
    const bidsV1 = await buildOrLoadFixture('qinghe-bids')
    const designV1 = await buildOrLoadFixture('qinghe-design')
    const bidsDup = await buildOrLoadFixture('qinghe-bids-dup')
    const bidsV2 = await buildOrLoadFixture('qinghe-bids-v020')
    const bidsDown = await buildOrLoadFixture('qinghe-bids-downgrade')
    summary.builds = {
      bidsV1: { path: bidsV1.receipt.artifactPath, sha256: bidsV1.receipt.artifactSha256, bytes: bidsV1.receipt.artifactBytes, seedHash: bidsV1.receipt.seedHash },
      designV1: { path: designV1.receipt.artifactPath, sha256: designV1.receipt.artifactSha256, bytes: designV1.receipt.artifactBytes },
      bidsDup: { path: bidsDup.receipt.artifactPath, sha256: bidsDup.receipt.artifactSha256, bytes: bidsDup.receipt.artifactBytes },
      bidsV2: { path: bidsV2.receipt.artifactPath, sha256: bidsV2.receipt.artifactSha256, bytes: bidsV2.receipt.artifactBytes, seedHash: bidsV2.receipt.seedHash },
      bidsDown: { path: bidsDown.receipt.artifactPath, sha256: bidsDown.receipt.artifactSha256, bytes: bidsDown.receipt.artifactBytes },
    }

    console.log('\n=== PHASE B: Silent Install + Electron Fuses + Live Launch Smoke (qinghe-bids v0.1.0) ===')
    const bidsInstDir = path.join(installRoot, 'bids')
    runNsisSilent(bidsV1.receipt.artifactPath, bidsInstDir)
    const bidsExe = path.join(bidsInstDir, `${bidsSlug}.exe`)
    assert(existsSync(bidsExe), `Installed exe missing: ${bidsExe}`)
    const fuses = await builderMod.verifyElectronFuses(bidsExe)
    assert(fuses.RunAsNode === false && fuses.OnlyLoadAppFromAsar === true && fuses.EnableCookieEncryption === true, `Fuses mismatch: ${JSON.stringify(fuses)}`)

    const bidsLink1 = readRegValue(bidsSpec.identity.nsisGuid, 'DshSelfShortcutPath')
    const bidsDesk1 = readRegValue(bidsSpec.identity.nsisGuid, 'DshSelfDesktopLink')
    assert(bidsLink1 && existsSync(bidsLink1), `Bids v1 Start Menu shortcut missing: ${bidsLink1}`)
    assert(bidsDesk1 && existsSync(bidsDesk1), `Bids v1 Desktop shortcut missing: ${bidsDesk1}`)
    assert(readRegValue(bidsSpec.identity.nsisGuid, 'AppVersion') === '0.1.0', 'Expected AppVersion 0.1.0')

    const bidsSmoke1 = await smokeLaunchInstalledExe(bidsExe, path.join(e2eRoot, 'smoke-bids-v1.json'))
    console.log('[win-e2e] qinghe-bids v0.1.0 live launch:', JSON.stringify(bidsSmoke1))
    assert(bidsSmoke1.ok === true, `qinghe-bids v0.1.0 smoke failed: ${JSON.stringify(bidsSmoke1)}`)
    assert(bidsSmoke1.productSpecStatus === 200, `Expected /api/product-spec HTTP 200, got ${bidsSmoke1.productSpecStatus}`)
    const bidsActiveProfile1 = JSON.parse(readFileSync(path.join(appData, bidsSlug, 'active-profile.json'), 'utf8'))
    assert(bidsActiveProfile1.state === 'verified', `Expected verified profile slot, got ${bidsActiveProfile1.state}`)
    summary.checks.bidsV1Launch = {
      ok: true,
      elapsedMs: bidsSmoke1.elapsedMs,
      profileSlot: bidsActiveProfile1.active,
      port: bidsSmoke1.hostPort,
      productSpecStatus: bidsSmoke1.productSpecStatus,
      orphanReaped: true,
      fuses,
    }

    console.log('\n=== PHASE C: Coexistence (qinghe-design) & Same-Name Disambiguation (qinghe-bids-dup) ===')
    const designInstDir = path.join(installRoot, 'design')
    runNsisSilent(designV1.receipt.artifactPath, designInstDir)
    const designExe = path.join(designInstDir, `${designSlug}.exe`)
    assert(existsSync(designExe), `Installed design exe missing: ${designExe}`)
    const designSmoke = await smokeLaunchInstalledExe(designExe, path.join(e2eRoot, 'smoke-design-v1.json'))
    console.log('[win-e2e] qinghe-design v0.1.0 live launch:', JSON.stringify(designSmoke))
    assert(designSmoke.ok === true, `qinghe-design smoke failed: ${JSON.stringify(designSmoke)}`)
    assert(designSmoke.userDataDir !== bidsSmoke1.userDataDir, 'Coexisting apps must have separate userDataDir')

    const dupInstDir = path.join(installRoot, 'bids-dup')
    runNsisSilent(bidsDup.receipt.artifactPath, dupInstDir)
    const dupLink = readRegValue(dupSpec.identity.nsisGuid, 'DshSelfShortcutPath')
    console.log(`[win-e2e] Same-name shortcuts:\n  bids="${bidsLink1}"\n  dup ="${dupLink}"`)
    assert(dupLink && existsSync(dupLink), `Dup shortcut missing: ${dupLink}`)
    assert(dupLink !== bidsLink1 && dupLink.includes('33333333'), `Expected disambiguated shortcut with (33333333), got ${dupLink}`)
    assert(existsSync(bidsLink1), 'Original qinghe-bids shortcut must not be clobbered by same-name sibling')
    summary.checks.coexistenceAndDisambiguation = { ok: true, bidsLink1, dupLink, designPort: designSmoke.hostPort, designElapsedMs: designSmoke.elapsedMs }

    console.log('\n=== PHASE D: Rename Upgrade (v0.1.0 -> v0.2.0 "青禾投标 Pro") + Dual-Slot Switch + Data Preservation ===')
    const sentinelFile = path.join(appData, bidsSlug, 'user-sentinel.txt')
    writeFileSync(sentinelFile, 'KEEP-MY-DATA-ACROSS-RENAME-UPGRADE', 'utf8')
    runNsisSilent(bidsV2.receipt.artifactPath, bidsInstDir)
    const bidsLink2 = readRegValue(bidsSpec.identity.nsisGuid, 'DshSelfShortcutPath')
    console.log(`[win-e2e] Renamed upgrade shortcut:\n  old="${bidsLink1}"\n  new="${bidsLink2}"`)
    assert(!existsSync(bidsLink1), `Stale old shortcut should have been removed: ${bidsLink1}`)
    assert(bidsLink2 && existsSync(bidsLink2) && bidsLink2.includes('Pro'), `New renamed shortcut missing: ${bidsLink2}`)
    assert(readRegValue(bidsSpec.identity.nsisGuid, 'AppVersion') === '0.2.0', 'Expected AppVersion 0.2.0')
    assert(readRegValue(bidsSpec.identity.nsisGuid, 'DataSchemaVersion') === '2', 'Expected DataSchemaVersion 2')
    assert(readFileSync(sentinelFile, 'utf8') === 'KEEP-MY-DATA-ACROSS-RENAME-UPGRADE', 'User data sentinel lost on upgrade!')

    // Plant valid dsh-credentials-local `.credentials.yaml` & secret log line to verify real packaged redacted diagnostic export
    const fakeCredsPath = path.join(appData, bidsSlug, 'h', '.credentials.yaml')
    writeFileSync(fakeCredsPath, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-secret-never-export-999999999\n', 'utf8')
    const bidsLogFile = path.join(appData, bidsSlug, 'logs', 'host.log')
    mkdirSync(path.dirname(bidsLogFile), { recursive: true })
    writeFileSync(
      bidsLogFile,
      `${existsSync(bidsLogFile) ? readFileSync(bidsLogFile, 'utf8') : ''}\nDEBUG auth header Bearer sk-live-secret1234567890abcdef token=tok_sensitive_999\n`,
      'utf8',
    )
    const diagZipPath = path.join(e2eRoot, 'bids-v2-diagnostics.zip')
    rmSync(diagZipPath, { force: true })

    const bidsSmoke2 = await smokeLaunchInstalledExe(bidsExe, path.join(e2eRoot, 'smoke-bids-v2.json'), {
      DSH_SELF_SMOKE_DIAGNOSTICS_ZIP: diagZipPath,
    })
    console.log('[win-e2e] qinghe-bids v0.2.0 live launch:', JSON.stringify(bidsSmoke2))
    assert(bidsSmoke2.ok === true && bidsSmoke2.appVersion === '0.2.0', `v0.2.0 launch failed: ${JSON.stringify(bidsSmoke2)}`)
    assert(bidsSmoke2.productSpecStatus === 200, `Expected v0.2.0 /api/product-spec HTTP 200, got ${bidsSmoke2.productSpecStatus}`)
    const bidsActiveProfile2 = JSON.parse(readFileSync(path.join(appData, bidsSlug, 'active-profile.json'), 'utf8'))
    assert(bidsActiveProfile2.active !== bidsActiveProfile1.active, 'Expected dual-slot switch to new seedHash slot')
    assert(bidsActiveProfile2.previous === bidsActiveProfile1.active, 'Expected previous slot preserved for rollback')
    assert(bidsActiveProfile2.state === 'verified', `Expected verified slot after upgrade, got ${bidsActiveProfile2.state}`)
    const stateVer = JSON.parse(readFileSync(path.join(appData, bidsSlug, 'state-version.json'), 'utf8'))
    assert(stateVer.dataFormatVersion === 2, `Expected state-version dataFormatVersion=2, got ${stateVer.dataFormatVersion}`)

    // Verify real redacted diagnostic bundle exported by packaged app.asar
    assert(existsSync(diagZipPath), `Redacted diagnostic zip not produced: ${diagZipPath}`)
    const diagEntries = unzipSync(readFileSync(diagZipPath))
    const diagNames = Object.keys(diagEntries)
    assert(diagNames.includes('product/product.json') && diagNames.includes('product/seed-manifest.json'), `Missing product metadata in diag zip: ${diagNames.join(',')}`)
    assert(diagNames.includes('state/active-profile.json') && diagNames.includes('state/state-version.json'), `Missing runtime state in diag zip: ${diagNames.join(',')}`)
    assert(diagNames.includes('logs/host.log'), `Missing logs/host.log in diag zip: ${diagNames.join(',')}`)
    assert(!diagNames.some((n) => n.includes('.credentials')), `Credentials leaked into diag zip: ${diagNames.join(',')}`)
    const redactedLogText = strFromU8(diagEntries['logs/host.log'])
    assert(!redactedLogText.includes('sk-live-secret1234567890abcdef'), 'API key leaked unredacted in diag zip host.log!')
    assert(!redactedLogText.includes('tok_sensitive_999'), 'Bearer/token leaked unredacted in diag zip host.log!')
    assert(redactedLogText.includes('***'), 'Expected *** redaction marker in diag zip host.log')
    console.log(`[win-e2e] Redacted diagnostic bundle verified (${diagNames.length} safe entries, 0 secrets leaked).`)

    summary.checks.renameUpgradeAndDualSlot = {
      ok: true,
      oldSlot: bidsActiveProfile1.active,
      newSlot: bidsActiveProfile2.active,
      newShortcut: bidsLink2,
      elapsedMs: bidsSmoke2.elapsedMs,
      productSpecStatus: bidsSmoke2.productSpecStatus,
      redactedDiagEntries: diagNames.length,
    }

    console.log('\n=== PHASE E: NSIS Downgrade Block Verification (v0.2.0 -> v0.0.9) ===')
    const downRes = runNsisSilent(bidsDown.receipt.artifactPath, bidsInstDir, { allowNonZero: true })
    console.log(`[win-e2e] Downgrade installer exit code: ${downRes.code}`)
    assert(downRes.code !== 0, 'Downgrade installer MUST abort with non-zero exit code!')
    assert(readRegValue(bidsSpec.identity.nsisGuid, 'AppVersion') === '0.2.0', 'Registry AppVersion must remain 0.2.0 after blocked downgrade')
    summary.checks.downgradeBlocked = { ok: true, exitCode: downRes.code }

    console.log('\n=== PHASE F: Unilateral Uninstall (does NOT touch sibling same-name app) ===')
    const bidsUninst = findUninstaller(bidsInstDir)
    assert(bidsUninst, 'Bids uninstaller not found')
    runNsisSilent(bidsUninst)
    await new Promise((r) => setTimeout(r, 1_500))
    assert(!existsSync(bidsLink2), 'Uninstalled app shortcut should be removed')
    assert(existsSync(dupLink), 'Sibling same-name app shortcut MUST remain intact after unilateral uninstall!')
    assert(existsSync(designExe), 'Sibling qinghe-design MUST remain intact after unilateral uninstall!')
    summary.checks.unilateralUninstall = { ok: true }

    writeFileSync(path.join(e2eRoot, 'win-e2e-report.json'), `${JSON.stringify(summary, undefined, 2)}\n`)
    console.log('\n=== ALL REAL WINDOWS E2E PACKAGING & INSTALL CHECKS PASSED 100% ===')
  } finally {
    console.log('[win-e2e] Cleaning up test installations, shortcuts, registry keys & test AppData...')
    cleanTestInstallState(allSlugs)
  }
}

await main()
