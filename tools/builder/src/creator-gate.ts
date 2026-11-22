import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'

export interface CreatorGateCheckResult {
  readonly passed: boolean
  readonly track: 'track-a-official-bundle' | 'track-b-multi-platform'
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[]
}

/**
 * M5 Track A Creator Gate: verifies that the self-contained `dsh-self-studio` bundle
 * satisfies every hard requirement for direct installation into official `dsh@0.2.2-rc.5`:
 * - Zero `workspace:*` specifiers in `package.json`
 * - Declares `engines.dsh`
 * - Plain `cordis.patch.yml` without `!!js`
 * - Zero references to OctoDeEpSeeK private APIs (`OCTO_`, `octo-desktop`, etc.)
 * - Independent child workers present (`dist/workers/fetch-worker.js`, `dist/workers/preview-worker.js`)
 */
export function verifyTrackAOfficialStudioBundle(bundleDir: string): CreatorGateCheckResult {
  const checks: { name: string; ok: boolean; detail: string }[] = []

  const pkgPath = path.join(bundleDir, 'package.json')
  if (!existsSync(pkgPath)) {
    return {
      passed: false,
      track: 'track-a-official-bundle',
      checks: [{ name: 'package.json exists', ok: false, detail: `Missing ${pkgPath}` }],
    }
  }
  const pkgText = readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgText) as {
    engines?: Record<string, string>
    dependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: string }; client?: unknown }
  }

  checks.push({
    name: 'zero-workspace-deps',
    ok: !pkgText.includes('workspace:'),
    detail: pkgText.includes('workspace:') ? 'Found forbidden workspace:* in bundle package.json' : 'Clean (0 workspace:*)',
  })
  checks.push({
    name: 'declares-engines-dsh',
    ok: typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0,
    detail: `engines.dsh=${String(pkg.engines?.dsh ?? 'missing')}`,
  })
  checks.push({
    name: 'declares-dsh-bundle-and-client',
    ok: Boolean(pkg.dsh?.bundle?.patch && pkg.dsh?.client),
    detail: `patch=${String(pkg.dsh?.bundle?.patch ?? 'missing')}`,
  })

  const patchPath = path.join(bundleDir, 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const patchDoc = parseDocument(patchText, { schema: 'core', customTags: [] })
  checks.push({
    name: 'plain-yaml-no-js-tag',
    ok: existsSync(patchPath) && patchDoc.errors.length === 0 && !/!!js\b/.test(patchText),
    detail: existsSync(patchPath) ? 'Valid plain YAML' : 'Missing cordis.patch.yml',
  })

  const hostJsPath = path.join(bundleDir, 'dist', 'index.js')
  const hostCode = existsSync(hostJsPath) ? readFileSync(hostJsPath, 'utf8') : ''
  const hasOctoPrivate = /OCTO_HOST|octo-desktop|registerHooks/.test(hostCode)
  checks.push({
    name: 'zero-octo-private-apis',
    ok: existsSync(hostJsPath) && !hasOctoPrivate,
    detail: hasOctoPrivate ? 'Detected forbidden OctoDeEpSeeK private reference' : 'Clean (official dsh APIs only)',
  })

  const fetchWorkerOk = existsSync(path.join(bundleDir, 'dist', 'workers', 'fetch-worker.js'))
  const previewWorkerOk = existsSync(path.join(bundleDir, 'dist', 'workers', 'preview-worker.js'))
  const clientBundleOk = existsSync(path.join(bundleDir, 'lib', 'client.js'))
  checks.push({
    name: 'independent-workers-and-client-present',
    ok: fetchWorkerOk && previewWorkerOk && clientBundleOk,
    detail: `fetch=${fetchWorkerOk}, preview=${previewWorkerOk}, client=${clientBundleOk}`,
  })

  return {
    passed: checks.every((c) => c.ok),
    track: 'track-a-official-bundle',
    checks,
  }
}
