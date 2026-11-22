import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '@dsh-self/catalog'
import { PINNED_DSH_RUNTIME_VERSION } from '@dsh-self/product-spec'

const APP_BOOT_PATH =
  process.env.DSH_APP_BOOT_PATH ??
  path.resolve('..', 'OctoDEepSeeK', 'apps', 'desktop', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')

describe('upstream dsh@0.2.2-rc.5 runtime contract verification', () => {
  it.skipIf(!existsSync(APP_BOOT_PATH))('verifies official evaluatePluginCompatibility against bundled dsh-self-studio & catalog entries', async () => {
    const boot = await import(pathToFileURL(APP_BOOT_PATH).href)
    const runtimeVersion: string = boot.getDshRuntimeVersion()
    expect(runtimeVersion).toBe(PINNED_DSH_RUNTIME_VERSION)

    // 1. Self-contained dsh-self-studio bundle MUST pass official evaluatePluginCompatibility with 0 unmet requirements
    const studioManifest = JSON.parse(
      readFileSync(path.resolve('.dev/studio-bundle/dsh-self-studio/package.json'), 'utf8'),
    )
    expect(JSON.stringify(studioManifest)).not.toContain('workspace:')
    expect(boot.evaluatePluginCompatibility(studioManifest, {}, runtimeVersion)).toBeUndefined()

    // 2. dsh-tender-workbench@0.5.11 MUST report exact 13 unmet peer requirements
    const tender = DEFAULT_CATALOG.find((e) => e.packageName === 'dsh-tender-workbench')!
    const tenderResult = boot.evaluatePluginCompatibility(tender.manifest, {}, runtimeVersion)
    expect(tenderResult).toBeDefined()
    expect(Object.keys(tenderResult.requirements).length).toBe(13)

    // 3. Builtin adapters MUST pass with 0 unmet requirements
    for (const entry of DEFAULT_CATALOG.filter((e) => e.trustTier === 'builtin')) {
      expect(boot.evaluatePluginCompatibility(entry.manifest, {}, runtimeVersion)).toBeUndefined()
    }
  })

  it('verifies dsh-shell-product compiles client.docx-viewer.js as a separate lazy chunk', () => {
    const mainChunk = readFileSync(
      path.resolve('templates/desktop/plugins/dsh-shell-product/lib/client.js'),
      'utf8',
    )
    const lazyChunkPath = path.resolve('templates/desktop/plugins/dsh-shell-product/lib/client.docx-viewer.js')
    expect(existsSync(lazyChunkPath)).toBe(true)
    const lazyChunk = readFileSync(lazyChunkPath, 'utf8')
    expect(lazyChunk).toContain('sanitizeDocxHtml')
    expect(lazyChunk).toContain('DOMPurify')
    expect(mainChunk).not.toContain('sanitizeDocxHtml')
    expect(mainChunk).not.toContain('DOMPurify')
  })
})
