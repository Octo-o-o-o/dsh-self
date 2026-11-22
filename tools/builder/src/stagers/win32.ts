import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as ResEdit from 'resedit'
import { Arch, Platform, build as electronBuild } from 'electron-builder'
import {
  PINNED_TEMPLATE_COMMIT,
  BuildReceiptSchema,
  type BuildReceipt,
} from '@dsh-self/product-spec'
import { generateProductIcons } from '../icon-gen.js'
import { ensureExternalPluginPayloads } from '../external-plugins.js'
import { generateParameterizedNsisInclude } from '../nsis-generator.js'
import { buildProfileSeed } from '../seed-builder.js'
import { sha256File, type ValidatedBuildSnapshot } from '../validate-and-snapshot.js'

function semverToWinVersionParts(semverStr: string): [number, number, number, number] {
  const m = semverStr.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return [0, 1, 0, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3]), 0]
}

/**
 * Pure-JS Windows PE resource stamping via `resedit@1.7.2` (zero `winCodeSign` native binary):
 * - Replaces executable icon group with the product's generated `.ico`
 * - Updates VersionInfo (`FileDescription`, `ProductName`, `OriginalFilename`, `InternalName`, versions)
 * - Preserves all unrelated custom PE resources (including Electron `INTEGRITY/ELECTRONASAR` if present)
 */
export function stampWin32ExecutablePe(options: {
  readonly exePath: string
  readonly icoPath: string
  readonly productName: string
  readonly internalSlug: string
  readonly appVersion: string
}): void {
  const exeBytes = readFileSync(options.exePath)
  const exe = ResEdit.NtExecutable.from(exeBytes, { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)

  // Replace icon group (ID 1 is Electron's primary icon group)
  const iconFile = ResEdit.Data.IconFile.from(readFileSync(options.icoPath))
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((item) => item.data),
  )

  // Update StringFileInfo / VersionInfo
  const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries)
  if (viList.length > 0) {
    const vi = viList[0]!
    const [maj, min, pat, rev] = semverToWinVersionParts(options.appVersion)
    vi.setFileVersion(maj, min, pat, rev, 1033)
    vi.setProductVersion(maj, min, pat, rev, 1033)
    vi.setStringValues(
      { lang: 1033, codepage: 1200 },
      {
        FileDescription: options.productName,
        ProductName: options.productName,
        InternalName: options.internalSlug,
        OriginalFilename: `${options.internalSlug}.exe`,
        FileVersion: options.appVersion,
        ProductVersion: options.appVersion,
        CompanyName: 'dsh-self',
      },
    )
    vi.outputToResourceEntries(res.entries)
  }

  res.outputResource(exe)
  const outBuf = Buffer.from(exe.generate())
  writeFileSync(options.exePath, outBuf)
}

export interface BuildWin32InstallerOptions {
  readonly snapshot: ValidatedBuildSnapshot
  readonly baseShellDir: string
  readonly outDir: string
  readonly jobId: string
  readonly extraSeedSalt?: string
  readonly pluginCacheDir?: string
}

/**
 * Full offline Windows x64 NSIS build pipeline:
 * 1. Copies immutable `base-shell` to isolated staging dir
 * 2. Renames `electron.exe` -> `<internalSlug>.exe` and stamps PE icon + metadata via pure-JS `resedit`
 * 3. Injects `resources/product/{product.json, identity.json, seed-manifest.json, profile-seed.tar.gz, lock, icon.png}`
 * 4. Emits temporary `package.json` with `name = internalSlug` + parameterized `installer.nsh`
 * 5. Invokes `electron-builder --prepackaged` with `signExecutable: false` (zero `winCodeSign` download!)
 * 6. Emits signed/unsigned `build-receipt.json` with exact SHA-256 and byte length
 */
export async function buildWin32Installer(options: BuildWin32InstallerOptions): Promise<BuildReceipt> {
  const { spec, lock, identity } = options.snapshot
  const slug = spec.identity.internalSlug
  const outDir = path.resolve(options.outDir)
  const workDir = path.join(outDir, '.work-win32')
  const stagingDir = path.join(workDir, 'staging')
  const iconsDir = path.join(workDir, 'icons')
  const productOutDir = path.join(stagingDir, 'resources', 'product')

  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  if (!existsSync(path.join(options.baseShellDir, 'electron.exe'))) {
    throw new Error(`base-shell missing electron.exe: ${options.baseShellDir}`)
  }

  // 1. Copy base-shell into staging
  cpSync(options.baseShellDir, stagingDir, { recursive: true })

  // 2. Generate brand icons (.ico + .png)
  const icons = await generateProductIcons({
    spec,
    outDir: iconsDir,
    iconSourcePath: options.snapshot.iconSourcePath,
  })

  // 3. Rename electron.exe -> <internalSlug>.exe and stamp PE icon + version strings
  const stagedExe = path.join(stagingDir, `${slug}.exe`)
  renameSync(path.join(stagingDir, 'electron.exe'), stagedExe)
  stampWin32ExecutablePe({
    exePath: stagedExe,
    icoPath: icons.icoPath,
    productName: spec.brand.displayName.zh || spec.brand.displayName.en,
    internalSlug: slug,
    appVersion: spec.appVersion,
  })

  // 4. Write resources/product/* + deterministic profile seed
  mkdirSync(productOutDir, { recursive: true })
  writeFileSync(path.join(productOutDir, 'product.json'), `${JSON.stringify(spec, undefined, 2)}\n`)
  writeFileSync(path.join(productOutDir, 'identity.json'), `${JSON.stringify(identity, undefined, 2)}\n`)
  writeFileSync(path.join(productOutDir, 'plugins.win32-x64.lock.json'), `${JSON.stringify(lock, undefined, 2)}\n`)
  cpSync(icons.png256Path, path.join(productOutDir, 'icon.png'))

  await ensureExternalPluginPayloads(lock, { pluginCacheDir: options.pluginCacheDir })
  const seed = buildProfileSeed({
    spec,
    lock,
    outDir: productOutDir,
    extraSeedSalt: options.extraSeedSalt,
    pluginCacheDir: options.pluginCacheDir,
  })

  // 5. Generate parameterized NSIS installer.nsh (UTF-8 BOM for NSIS Unicode) & temporary package.json (`name = internalSlug`!)
  const nsisIncludePath = path.join(workDir, 'installer.nsh')
  writeFileSync(nsisIncludePath, `\uFEFF${generateParameterizedNsisInclude(spec)}`, 'utf8')

  writeFileSync(
    path.join(workDir, 'package.json'),
    `${JSON.stringify({
      name: slug,
      version: spec.appVersion,
      description: spec.brand.displayName.en,
      author: 'dsh-self',
      main: 'dist/main.js',
    }, undefined, 2)}\n`,
  )

  const artifactName = `${slug}-${spec.appVersion}-win32-x64-setup.exe`
  const distOutDir = path.join(outDir, 'dist')
  mkdirSync(distOutDir, { recursive: true })

  // 6. Wrap staged directory into NSIS installer via `--prepackaged` (zero winCodeSign!)
  await electronBuild({
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    prepackaged: stagingDir,
    projectDir: workDir,
    config: {
      appId: spec.identity.appId,
      productName: spec.brand.displayName.zh || spec.brand.displayName.en,
      electronVersion: '44.11.5',
      compression: 'normal',
      directories: {
        output: distOutDir,
      },
      win: {
        executableName: slug,
        icon: icons.icoPath,
        signExecutable: false,
        signAndEditExecutable: false,
      },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        runAfterFinish: true,
        guid: spec.identity.nsisGuid,
        include: nsisIncludePath,
        artifactName,
        installerIcon: icons.icoPath,
        uninstallerIcon: icons.icoPath,
        installerHeaderIcon: icons.icoPath,
        deleteAppDataOnUninstall: false,
        differentialPackage: false,
      },
    },
  })

  const finalExePath = path.join(distOutDir, artifactName)
  if (!existsSync(finalExePath)) {
    throw new Error(`Expected NSIS installer not produced: ${finalExePath}`)
  }

  // Copy final installer to top-level outDir for ergonomic discovery
  const exportedInstallerPath = path.join(outDir, artifactName)
  cpSync(finalExePath, exportedInstallerPath)

  const artifactSha256 = sha256File(exportedInstallerPath)
  const artifactBytes = statSync(exportedInstallerPath).size

  const receipt: BuildReceipt = BuildReceiptSchema.parse({
    schemaVersion: 1,
    jobId: options.jobId,
    dedupKey: options.snapshot.dedupKey,
    productId: spec.identity.productId,
    revision: spec.revision,
    appVersion: spec.appVersion,
    target: 'win32-x64',
    productDigest: options.snapshot.productDigest,
    lockDigest: options.snapshot.lockDigest,
    seedHash: seed.manifest.seedHash,
    templateCommit: PINNED_TEMPLATE_COMMIT,
    toolchainVersion: '0.1.0',
    distributionStatus: 'unsigned-local-test',
    artifactPath: exportedInstallerPath,
    artifactSha256,
    artifactBytes,
    builtAt: new Date().toISOString(),
  })
  writeFileSync(path.join(outDir, 'build-receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`)

  // Keep cleanup lean (remove heavy intermediate staging copy once installer is verified)
  rmSync(workDir, { recursive: true, force: true })
  return receipt
}
