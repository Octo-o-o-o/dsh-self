/**
 * Install the self-contained `dsh-self-studio` bundle directly into an isolated official
 * `dsh@0.2.2-rc.5` profile (`dsh web`) and start official `dsh web` so the user can test
 * the real UX immediately in their browser!
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packSelfContainedStudioBundle } from './pack-studio-bundle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const demoHome = path.join(root, '.dev', 'official-dsh-demo', 'dsh-home')
const demoWorkspace = path.join(root, '.dev', 'official-dsh-demo', 'workspace')
const studioDataDir = path.join(root, '.dev', 'official-dsh-demo', 'studio-projects')
const profileName = 'web'
const profileDir = path.join(demoHome, 'profiles', profileName)
const port = Number.parseInt(process.env.DSH_DEMO_PORT ?? '14567', 10)

const OFFICIAL_DSH_BIN =
  process.env.DSH_OFFICIAL_BIN ??
  path.resolve(root, '..', 'OctoDEepSeeK', 'apps', 'desktop', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

async function main() {
  if (!existsSync(OFFICIAL_DSH_BIN)) {
    throw new Error(`Official dsh@0.2.2-rc.5 CLI not found at ${OFFICIAL_DSH_BIN}`)
  }

  // 1. Pack 100% self-contained dsh-self-studio bundle (zero workspace:*)
  const { outDir } = await packSelfContainedStudioBundle()

  // 2. Prepare official dsh profile (`<DSH_HOME>/profiles/web`)
  mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(demoWorkspace, { recursive: true })
  mkdirSync(studioDataDir, { recursive: true })

  const installedBundleDir = path.join(profileDir, 'node_modules', 'dsh-self-studio')
  rmSync(installedBundleDir, { recursive: true, force: true })
  cpSync(outDir, installedBundleDir, { recursive: true })

  // Standard official dsh web profile manifest listing `dsh-self-studio` as an installed bundle
  const profileManifest = {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {
      'dsh-self-studio': '0.1.0',
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-self-studio',
        ],
      },
    },
  }
  writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, undefined, 2)}\n`)
  writeFileSync(path.join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    [
      '- id: ui-settings-general',
      '  config:',
      "    welcomeNoticeVersion: '2026-09-28.1'",
      '- id: session-log-deepseek',
      '  config:',
      '    enabled: false',
      '- id: ui-settings-models',
      '  config:',
      '    credentialOnboarding: false',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )

  const infoFile = path.join(root, '.dev', 'official-dsh-demo', 'demo-url.txt')
  console.log(`[official-dsh-demo] Launching official dsh@0.2.2-rc.5 web on http://127.0.0.1:${port} ...`)

  const builderCliPath = process.env.DSH_SELF_BUILDER_CLI || path.join(root, 'tools', 'builder', 'dist', 'cli.js')
  const baseShellWin32 = process.env.DSH_SELF_BASE_SHELL_DIR || path.join(root, '.dev', 'base-shell', 'win32-x64')
  const demoEnv = {
    ...process.env,
    DSH_HOME: demoHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_SELF_STUDIO_DATA_DIR: studioDataDir,
    ...(existsSync(builderCliPath) ? { DSH_SELF_BUILDER_CLI: builderCliPath } : {}),
    ...(existsSync(baseShellWin32) ? { DSH_SELF_BASE_SHELL_DIR: baseShellWin32 } : {}),
  }

  const child = spawn(
    process.execPath,
    [OFFICIAL_DSH_BIN, '--profile', profileName, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: demoWorkspace,
      env: demoEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  const urlRe = /(https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/
  let printedUrl = false
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    process.stdout.write(text)
    if (!printedUrl) {
      const m = urlRe.exec(text)
      if (m?.[1]) {
        printedUrl = true
        writeFileSync(infoFile, `${m[1]}\n`)
        console.log(`\n=== OFFICIAL DSH DEMO READY ===\nURL: ${m[1]}\n===============================\n`)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk.toString('utf8'))
  })
  child.once('exit', (code, signal) => {
    console.log(`[official-dsh-demo] dsh web exited (code=${code}, signal=${signal})`)
    process.exit(code ?? 0)
  })
}

await main()
