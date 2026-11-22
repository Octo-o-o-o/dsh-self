import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { isWindowsReservedName } from '@dsh-self/product-spec'

export interface TarExtractQuotas {
  readonly maxEntries: number
  readonly maxSingleFileBytes: number
  readonly maxTotalBytes: number
  readonly maxDepth: number
}

export const DEFAULT_TAR_QUOTAS: TarExtractQuotas = {
  maxEntries: 20_000,
  maxSingleFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxDepth: 24,
}

export const MAX_SEED_REL_PATH_BUDGET = 130

export class UnsafeTarError extends Error {
  readonly code:
    | 'SHA256_MISMATCH'
    | 'QUOTA_EXCEEDED'
    | 'UNSAFE_ENTRY_TYPE'
    | 'UNSAFE_PATH'
    | 'CASE_COLLISION'
    | 'MALFORMED_TAR'

  constructor(code: UnsafeTarError['code'], message: string) {
    super(message)
    this.name = 'UnsafeTarError'
    this.code = code
  }
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = value.toString(8).padStart(length - 1, '0')
  buf.write(str.slice(-(length - 1)), offset, length - 1, 'ascii')
  buf[offset + length - 1] = 0
}

function computeHeaderChecksum(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < 512; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i]!
  }
  return sum
}

function buildPaxHeaderRecord(key: string, value: string): Buffer {
  const payload = ` ${key}=${value}\n`
  let len = Buffer.byteLength(payload, 'utf8') + 2
  while (true) {
    const line = `${len}${payload}`
    const actual = Buffer.byteLength(line, 'utf8')
    if (actual === len) return Buffer.from(line, 'utf8')
    len = actual
  }
}

function buildUstarHeader(options: {
  readonly name: string
  readonly size: number
  readonly mode: number
  readonly typeflag: '0' | '5' | 'x'
}): Buffer {
  const header = Buffer.alloc(512, 0)
  const nameBytes = Buffer.from(options.name, 'utf8')
  if (nameBytes.length <= 100) {
    nameBytes.copy(header, 0)
  } else {
    nameBytes.subarray(0, 100).copy(header, 0)
  }
  writeOctal(header, 100, 8, options.mode)
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, options.size)
  writeOctal(header, 136, 12, 0) // deterministic mtime = epoch 0
  header.fill(0x20, 148, 156)
  header[156] = options.typeflag.charCodeAt(0)
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = computeHeaderChecksum(header)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function pad512(data: Buffer): Buffer {
  const rem = data.length % 512
  if (rem === 0) return data
  return Buffer.concat([data, Buffer.alloc(512 - rem, 0)])
}

/** Validate a relative archive entry path against all Windows/POSIX traversal & device hazards. */
export function validateSafeArchiveRelPath(rawPath: string, maxDepth = DEFAULT_TAR_QUOTAS.maxDepth): string {
  if (rawPath.length === 0) throw new UnsafeTarError('UNSAFE_PATH', 'Empty TAR entry path')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawPath)) {
    throw new UnsafeTarError('UNSAFE_PATH', `Control/NUL character in TAR entry: ${JSON.stringify(rawPath)}`)
  }
  if (rawPath.includes('\\')) {
    throw new UnsafeTarError('UNSAFE_PATH', `Backslash forbidden in TAR entry: ${rawPath}`)
  }
  if (rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) {
    throw new UnsafeTarError('UNSAFE_PATH', `Absolute or drive-qualified path rejected: ${rawPath}`)
  }
  const trimmed = rawPath.replace(/\/+$/, '')
  const segments = trimmed.split('/').filter((s) => s !== '.' && s.length > 0)
  if (segments.length === 0) throw new UnsafeTarError('UNSAFE_PATH', `Empty normalized path: ${rawPath}`)
  if (segments.length > maxDepth) {
    throw new UnsafeTarError('QUOTA_EXCEEDED', `Path depth ${segments.length} exceeds limit ${maxDepth}: ${rawPath}`)
  }
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new UnsafeTarError('UNSAFE_PATH', `Path traversal rejected: ${rawPath}`)
    }
    if (seg.includes(':')) {
      throw new UnsafeTarError('UNSAFE_PATH', `NTFS ADS colon rejected: ${rawPath}`)
    }
    if (/[. ]$/.test(seg)) {
      throw new UnsafeTarError('UNSAFE_PATH', `Trailing dot or space rejected (Windows hazard): ${rawPath}`)
    }
    if (/[*?"<>|]/.test(seg)) {
      throw new UnsafeTarError('UNSAFE_PATH', `Illegal Windows filename char rejected: ${rawPath}`)
    }
    if (isWindowsReservedName(seg)) {
      throw new UnsafeTarError('UNSAFE_PATH', `Windows reserved device name rejected: ${rawPath}`)
    }
  }
  return segments.join('/')
}

/** Measure the longest relative path inside a directory tree (enforcing MAX_PATH budget). */
export function measureMaxRelPath(rootDir: string): { readonly maxRelPath: number; readonly longestEntry: string } {
  let maxRelPath = 0
  let longestEntry = ''
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (rel.length > maxRelPath) {
        maxRelPath = rel.length
        longestEntry = rel
      }
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
    }
  }
  walk(rootDir, '')
  return { maxRelPath, longestEntry }
}

/**
 * Pack a directory tree into a deterministic PAX-capable `.tar.gz` buffer
 * (sorted entries, mtime 0, gzip mtime 0, zero symlinks/hardlinks).
 */
export function packDeterministicTarGz(
  sourceDir: string,
  options: { readonly maxRelPathBudget?: number } = {},
): { readonly buffer: Buffer; readonly sha256: string; readonly entryCount: number; readonly maxRelPath: number } {
  const budget = options.maxRelPathBudget ?? MAX_SEED_REL_PATH_BUDGET
  const chunks: Buffer[] = []
  let entryCount = 0
  let maxRelPath = 0

  const walk = (dir: string, prefix: string): void => {
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      const full = path.join(dir, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        throw new UnsafeTarError('UNSAFE_ENTRY_TYPE', `Refusing to pack symlink into seed archive: ${full}`)
      }
      const rel = prefix.length === 0 ? name : `${prefix}/${name}`
      const safeRel = validateSafeArchiveRelPath(rel)
      if (safeRel.length > maxRelPath) maxRelPath = safeRel.length
      if (safeRel.length > budget) {
        throw new UnsafeTarError(
          'QUOTA_EXCEEDED',
          `Seed entry "${safeRel}" length (${safeRel.length}) exceeds MAX_PATH budget (${budget})`,
        )
      }
      if (stat.isDirectory()) {
        const dirRel = `${safeRel}/`
        if (Buffer.byteLength(dirRel, 'utf8') > 100) {
          const paxData = buildPaxHeaderRecord('path', dirRel)
          chunks.push(buildUstarHeader({ name: 'PaxHeader', size: paxData.length, mode: 0o644, typeflag: 'x' }))
          chunks.push(pad512(paxData))
        }
        chunks.push(buildUstarHeader({ name: dirRel, size: 0, mode: 0o755, typeflag: '5' }))
        entryCount += 1
        walk(full, safeRel)
      } else if (stat.isFile()) {
        const data = readFileSync(full)
        if (Buffer.byteLength(safeRel, 'utf8') > 100) {
          const paxData = buildPaxHeaderRecord('path', safeRel)
          chunks.push(buildUstarHeader({ name: 'PaxHeader', size: paxData.length, mode: 0o644, typeflag: 'x' }))
          chunks.push(pad512(paxData))
        }
        chunks.push(buildUstarHeader({ name: safeRel, size: data.length, mode: 0o644, typeflag: '0' }))
        chunks.push(pad512(data))
        entryCount += 1
      } else {
        throw new UnsafeTarError('UNSAFE_ENTRY_TYPE', `Unsupported file type in seed: ${full}`)
      }
    }
  }

  walk(sourceDir, '')
  chunks.push(Buffer.alloc(1024, 0)) // TAR EOF blocks
  const tarBuf = Buffer.concat(chunks)
  const gzBuf = gzipSync(tarBuf, { level: 6 })
  // Zero gzip header mtime bytes (offsets 4..7) & OS byte (9) for determinism
  if (gzBuf.length >= 10) {
    gzBuf[4] = 0; gzBuf[5] = 0; gzBuf[6] = 0; gzBuf[7] = 0; gzBuf[9] = 0xff
  }
  const sha256 = createHash('sha256').update(gzBuf).digest('hex')
  return { buffer: gzBuf, sha256, entryCount, maxRelPath }
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  const text = data.toString('utf8')
  let pos = 0
  while (pos < text.length) {
    const space = text.indexOf(' ', pos)
    if (space === -1) break
    const len = Number.parseInt(text.slice(pos, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = text.slice(space + 1, pos + len).replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq > 0) {
      result[record.slice(0, eq)] = record.slice(eq + 1)
    }
    pos += len
  }
  return result
}

function parseOctalOrBase256(buf: Buffer): number {
  if ((buf[0]! & 0x80) !== 0) {
    let val = 0
    for (let i = 1; i < buf.length; i += 1) val = val * 256 + buf[i]!
    return val
  }
  const str = buf.toString('ascii').replace(/\0.*$/, '').trim()
  return str.length === 0 ? 0 : Number.parseInt(str, 8)
}

function readCString(buf: Buffer): string {
  const idx = buf.indexOf(0)
  return buf.subarray(0, idx === -1 ? buf.length : idx).toString('utf8')
}

/**
 * Verify SHA-256 and safely extract a PAX/ustar `.tar.gz` archive into `destDir`.
 * Rejects path traversal, symlinks/hardlinks, devices/FIFOs, Windows reserved names,
 * ADS colons, trailing dots/spaces, case collisions, and gzip/tar bombs.
 */
export function extractSafeTarGz(options: {
  readonly archiveBuffer: Buffer
  readonly destDir: string
  readonly expectedSha256?: string
  readonly quotas?: TarExtractQuotas
}): { readonly extractedFiles: number; readonly extractedBytes: number } {
  const quotas = options.quotas ?? DEFAULT_TAR_QUOTAS
  if (options.expectedSha256 !== undefined) {
    const actual = createHash('sha256').update(options.archiveBuffer).digest('hex')
    if (actual !== options.expectedSha256.toLowerCase()) {
      throw new UnsafeTarError(
        'SHA256_MISMATCH',
        `Archive SHA-256 mismatch: expected ${options.expectedSha256}, got ${actual}`,
      )
    }
  }

  let tarBuf: Buffer
  try {
    tarBuf = gunzipSync(options.archiveBuffer, { maxOutputLength: quotas.maxTotalBytes + 64 * 1024 * 1024 })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/maxOutputLength|Cannot create a Buffer|range/i.test(msg)) {
      throw new UnsafeTarError('QUOTA_EXCEEDED', `Gzip bomb quota exceeded: ${msg}`)
    }
    throw new UnsafeTarError('MALFORMED_TAR', `Invalid gzip archive: ${msg}`)
  }

  mkdirSync(options.destDir, { recursive: true })
  const resolvedDest = path.resolve(options.destDir)
  const seenLower = new Set<string>()
  let offset = 0
  let entries = 0
  let extractedFiles = 0
  let extractedBytes = 0
  let nextPax: Record<string, string> | null = null
  let nextGnuLongName: string | null = null

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    offset += 512
    // Zero block = EOF
    if (header.every((b) => b === 0)) break

    const rawName = readCString(header.subarray(0, 100))
    const rawPrefix = readCString(header.subarray(345, 500))
    const sizeField = parseOctalOrBase256(header.subarray(124, 136))
    const typeChar = header[156] === 0 ? '0' : String.fromCharCode(header[156]!)
    const dataSize = nextPax?.size !== undefined ? Number.parseInt(nextPax.size, 10) : sizeField
    if (!Number.isFinite(dataSize) || dataSize < 0) {
      throw new UnsafeTarError('MALFORMED_TAR', 'Invalid TAR entry size')
    }
    const padded = Math.ceil(dataSize / 512) * 512
    if (offset + dataSize > tarBuf.length) {
      throw new UnsafeTarError('MALFORMED_TAR', 'Truncated TAR entry payload')
    }
    const payload = tarBuf.subarray(offset, offset + dataSize)
    offset += padded

    if (typeChar === 'x') {
      nextPax = parsePaxRecords(payload)
      continue
    }
    if (typeChar === 'g') {
      continue
    }
    if (typeChar === 'L') {
      nextGnuLongName = readCString(payload)
      continue
    }

    const effectiveRawPath =
      nextPax?.path ??
      nextGnuLongName ??
      (rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName)
    nextPax = null
    nextGnuLongName = null

    if (typeChar !== '0' && typeChar !== '5') {
      throw new UnsafeTarError(
        'UNSAFE_ENTRY_TYPE',
        `Rejected non-regular TAR entry type '${typeChar}' for "${effectiveRawPath}" (symlinks/hardlinks/devices forbidden)`,
      )
    }

    entries += 1
    if (entries > quotas.maxEntries) {
      throw new UnsafeTarError('QUOTA_EXCEEDED', `TAR entry count exceeded quota ${quotas.maxEntries}`)
    }
    const safeRel = validateSafeArchiveRelPath(effectiveRawPath, quotas.maxDepth)
    const lowerKey = safeRel.toLowerCase()
    if (seenLower.has(lowerKey)) {
      throw new UnsafeTarError('CASE_COLLISION', `Case-insensitive path collision rejected: ${safeRel}`)
    }
    seenLower.add(lowerKey)

    const targetPath = path.resolve(resolvedDest, safeRel)
    if (targetPath !== resolvedDest && !targetPath.startsWith(`${resolvedDest}${path.sep}`)) {
      throw new UnsafeTarError('UNSAFE_PATH', `Resolved path escapes destination: ${safeRel}`)
    }

    if (typeChar === '5') {
      mkdirSync(targetPath, { recursive: true })
    } else {
      if (dataSize > quotas.maxSingleFileBytes) {
        throw new UnsafeTarError('QUOTA_EXCEEDED', `Single file "${safeRel}" exceeds ${quotas.maxSingleFileBytes} bytes`)
      }
      extractedBytes += dataSize
      if (extractedBytes > quotas.maxTotalBytes) {
        throw new UnsafeTarError('QUOTA_EXCEEDED', `Total extracted bytes exceed ${quotas.maxTotalBytes}`)
      }
      mkdirSync(path.dirname(targetPath), { recursive: true })
      if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
        throw new UnsafeTarError('UNSAFE_PATH', `File collides with directory: ${safeRel}`)
      }
      writeFileSync(targetPath, payload)
      extractedFiles += 1
    }
  }

  return { extractedFiles, extractedBytes }
}
