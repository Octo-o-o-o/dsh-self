import path from 'node:path'

const WINDOWS_ESSENTIALS = new Set([
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'SYSTEMDRIVE', 'PATH',
])

const POSIX_ESSENTIALS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG',
  'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'PATH',
  'TERM', 'COLORTERM',
])

const ENTERPRISE_NET_AND_CERTS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

function isAllowedBaseKey(key: string, platform: NodeJS.Platform): boolean {
  const upper = key.toUpperCase()
  // Never pass Node injection, linker preloads, Electron overrides, or external API keys
  if (upper.startsWith('NODE_') && upper !== 'NODE_EXTRA_CA_CERTS') return false
  if (upper.startsWith('LD_') || upper.startsWith('DYLD_')) return false
  if (upper.startsWith('ELECTRON_') || upper.startsWith('OCTO_') || upper.startsWith('DSH_')) return false
  if (
    upper.startsWith('DEEPSEEK_') ||
    upper.startsWith('OPENAI_') ||
    upper.startsWith('ANTHROPIC_') ||
    upper.startsWith('GEMINI_') ||
    upper.startsWith('GOOGLE_API_') ||
    upper.startsWith('AWS_')
  ) {
    return false
  }
  if (ENTERPRISE_NET_AND_CERTS.has(key) || ENTERPRISE_NET_AND_CERTS.has(upper)) return true
  if (platform === 'win32') return WINDOWS_ESSENTIALS.has(upper)
  if (POSIX_ESSENTIALS.has(key) || upper.startsWith('LC_') || upper.startsWith('XDG_')) return true
  return false
}

export interface HostEnvWhitelistOptions {
  readonly sourceEnv: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly dshHome: string
  readonly shimDir?: string
  readonly extraAllowed?: Readonly<Record<string, string>>
}

/**
 * Construct a strict minimal environment whitelist for spawning the bundled Node dsh Host
 * or `tools/builder`, blocking `NODE_OPTIONS`/`DEEPSEEK_API_KEY`/`DSH_*` injection while
 * preserving OS runtime essentials, enterprise proxies, and custom CA certificates.
 */
export function buildWhitelistedHostEnv(options: HostEnvWhitelistOptions): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(options.sourceEnv)) {
    if (value === undefined) continue
    if (isAllowedBaseKey(key, platform)) {
      out[key] = value
    }
  }

  if (options.shimDir !== undefined && options.shimDir.length > 0) {
    const pathKey = Object.keys(out).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
    const current = out[pathKey] ?? ''
    const delimiter = platform === 'win32' ? ';' : ':'
    out[pathKey] = current.length > 0 ? `${options.shimDir}${delimiter}${current}` : options.shimDir
  }

  out.DSH_HOME = path.resolve(options.dshHome)
  out.DSH_TELEMETRY_DISABLED = '1'

  if (options.extraAllowed) {
    for (const [key, value] of Object.entries(options.extraAllowed)) {
      out[key] = value
    }
  }
  return out
}
