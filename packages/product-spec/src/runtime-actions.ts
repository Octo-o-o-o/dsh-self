import type { ActionId } from './catalog-contract.js'
import type { LockedPluginEntry, PlatformLock, ProductSpec } from './schema.js'

// These implementations travel inside dsh-shell-product. External bundles require their own payload.
const shipped: Readonly<Record<string, readonly ActionId[]>> = {
  '@dsh-self/adapter-bid-docx': ['bid.importRequirements', 'bid.exportResponseDocx'],
  '@dsh-self/adapter-local-calendar': ['calendar.addDeadline'],
  '@dsh-self/adapter-design-canvas': ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
}

// Verified external DSH bundles that `tools/builder` materializes into `profile-seed.tar.gz`
// with exact SHA-512 integrity verification and `--ignore-scripts` dependency closure.
export const DELIVERABLE_EXTERNAL_BUNDLES: Readonly<Record<string, {
  readonly version: string
  readonly integritySha512: string
  readonly actions: readonly ActionId[]
}>> = {
  'chatgpt-pro-research': {
    version: '0.3.6',
    integritySha512: 'sha512-TOXQlk0uv7d+MiB7Pq0BbXBDWYynliqJxTkRLhF43T+ZGu/82JHeILRa1L0wwjdey/txVuxPUdqAXBge4tYL+w==',
    actions: ['research.openProResearch'],
  },
  'gpt-image-design': {
    version: '0.3.6',
    integritySha512: 'sha512-zNbPqlZnf/cub0P2okhtWpsa6YdEjNv5VPhcjIvdN7F40q4gf1EZlaRE3hHN4zBaopye65mOZfHGJ30kM1WQsA==',
    actions: ['design.openImageDesign'],
  },
}

export function isDeliverableExternalBundle(plugin: Pick<LockedPluginEntry, 'packageName' | 'version' | 'sourceKind' | 'integritySha512'>): boolean {
  if (plugin.sourceKind !== 'npm' && plugin.sourceKind !== 'git') return false
  if (!Object.hasOwn(DELIVERABLE_EXTERNAL_BUNDLES, plugin.packageName)) return false
  const spec = DELIVERABLE_EXTERNAL_BUNDLES[plugin.packageName]!
  return spec.version === plugin.version && spec.integritySha512 === plugin.integritySha512
}

export function desktopCapabilities(spec: ProductSpec, lock: PlatformLock) {
  const wanted = new Set([...spec.requiredActions, ...spec.optionalActions])
  const actions = new Set<ActionId>()
  const unavailablePackages: string[] = []
  const extraInstalledPackages: string[] = []
  for (const plugin of lock.plugins) {
    let supported: readonly ActionId[] | undefined
    if (plugin.sourceKind === 'builtin' && plugin.version === '0.1.0' && Object.hasOwn(shipped, plugin.packageName)) {
      supported = shipped[plugin.packageName]
    } else if (isDeliverableExternalBundle(plugin)) {
      supported = DELIVERABLE_EXTERNAL_BUNDLES[plugin.packageName]!.actions
    } else if (plugin.sourceKind === 'local-installed') {
      // Staged directly from the user's currently installed DSH profile into plugin-cache with SHA-512 integrity.
      // `ensureExternalPluginPayloads` and `buildProfileSeed` strictly enforce that the staged files exist and match.
      supported = plugin.providesActions
      extraInstalledPackages.push(plugin.packageName)
    }
    if (!supported) {
      unavailablePackages.push(plugin.packageName)
      continue
    }
    for (const action of supported) {
      if (wanted.has(action) && plugin.providesActions.includes(action)) actions.add(action)
    }
  }
  return {
    actions: [...actions],
    unavailablePackages,
    extraInstalledPackages,
    missing: spec.requiredActions.filter(action => !actions.has(action)),
  }
}
