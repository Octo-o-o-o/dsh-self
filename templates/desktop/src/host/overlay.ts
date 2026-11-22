import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'

export interface OverlayPlugin {
  readonly id: string
  readonly entry: string
}

export interface LaunchOverlayOptions {
  readonly plugins: readonly OverlayPlugin[]
  readonly previewMode?: boolean
  readonly disableToolWeb?: boolean
}

/**
 * Render `--patch` overlay via structured YAML serialization (zero raw interpolation, zero `!!js`).
 *
 * Notice what is intentionally NOT here:
 * - `ui-settings-general.welcomeNoticeVersion` and `session-log-deepseek.enabled: false`
 *   belong in the seed's `cordis.patch.yml` (NOT `--patch`, because `config-editor` rejects
 *   UI edits to entries overridden by `--patch`).
 * - In `previewMode`, disables Host write service `id: plugin-manager`, `id: ui-plugin-manager`,
 *   and `id: hmr` (closing the `presets/*.patch.yml` nested `tool-plugin-manager` bypass while
 *   keeping read-only `plugin-inventory`).
 */
export function renderLaunchOverlay(options: LaunchOverlayOptions): string {
  const rows: Record<string, unknown>[] = []
  if (options.plugins.length > 0) {
    rows.push({
      insert: options.plugins.map((plugin) => ({
        id: plugin.id,
        name: pathToFileURL(path.resolve(plugin.entry)).href,
      })),
    })
  }
  rows.push(
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'ui-settings-models', config: { credentialOnboarding: false } },
  )
  if (options.disableToolWeb) {
    rows.push({ id: 'tool-web', disabled: true })
  }
  if (options.previewMode) {
    rows.push(
      { id: 'plugin-manager', disabled: true },
      { id: 'ui-plugin-manager', disabled: true },
      { id: 'hmr', disabled: true },
    )
  }
  return `# Generated at launch by dsh-self desktop shell. Do not edit manually.\n${stringify(rows)}`
}
