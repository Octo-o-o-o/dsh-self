import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import ipaddr from 'ipaddr.js'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
])

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']
const ALLOWED_PORTS = new Set([80, 443])

/**
 * Return a non-null rejection reason if `ipLiteral` is loopback, private, CGNAT
 * (including Alibaba Cloud metadata 100.100.100.200), link-local (AWS/GCP/Azure 169.254.169.254),
 * unspecified (0.0.0.0/8, ::), ULA, NAT64, 6to4, Teredo, multicast, reserved, or IPv4-mapped private IPv6.
 */
export function checkIpSafety(ipLiteral: string): { readonly allowed: boolean; readonly reason?: string } {
  const clean = ipLiteral.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (!ipaddr.isValid(clean)) {
    return { allowed: false, reason: `Invalid IP literal: ${ipLiteral}` }
  }
  let parsed = ipaddr.parse(clean)
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address()
    } else {
      const range = v6.range()
      if (range !== 'unicast') {
        return { allowed: false, reason: `Blocked IPv6 range (${range}): ${clean}` }
      }
      // Explicitly block NAT64 (64:ff9b::/96, 64:ff9b:1::/48), 6to4 (2002::/16), Teredo (2001:0::/32)
      const parts = v6.parts
      if (parts[0] === 0x0064 && parts[1] === 0xff9b) {
        return { allowed: false, reason: `Blocked IPv6 NAT64 prefix: ${clean}` }
      }
      if (parts[0] === 0x2002) {
        return { allowed: false, reason: `Blocked IPv6 6to4 prefix: ${clean}` }
      }
      if (parts[0] === 0x2001 && parts[1] === 0x0000) {
        return { allowed: false, reason: `Blocked IPv6 Teredo prefix: ${clean}` }
      }
      return { allowed: true }
    }
  }

  const v4 = parsed as ipaddr.IPv4
  const range = v4.range()
  if (range !== 'unicast') {
    return { allowed: false, reason: `Blocked IPv4 range (${range}): ${clean}` }
  }
  // Extra explicit guards: 100.64.0.0/10 (CGNAT + Alibaba 100.100.100.200), 192.0.0.0/24, 198.18.0.0/15
  const o = v4.octets
  if (o[0] === 0) return { allowed: false, reason: `Blocked unspecified 0.0.0.0/8: ${clean}` }
  if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) {
    return { allowed: false, reason: `Blocked CGNAT / cloud metadata 100.64.0.0/10: ${clean}` }
  }
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) {
    return { allowed: false, reason: `Blocked IETF protocol assignment 192.0.0.0/24: ${clean}` }
  }
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) {
    return { allowed: false, reason: `Blocked benchmark 198.18.0.0/15: ${clean}` }
  }
  return { allowed: true }
}

export function validateUrlSyntaxAndPort(rawUrl: string): {
  readonly url: URL
  readonly hostname: string
  readonly port: number
} {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked protocol "${url.protocol}" (only http/https permitted)`)
  }
  if (url.username || url.password) {
    throw new Error('Embedded credentials in URL are forbidden')
  }
  const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80)
  if (!ALLOWED_PORTS.has(port)) {
    throw new Error(`Blocked target port ${port} (only ports 80 and 443 are permitted)`)
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new Error(`Blocked internal/reserved hostname: ${hostname}`)
  }
  return { url, hostname, port }
}

export type DnsResolverFn = (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>

const defaultResolver: DnsResolverFn = async (hostname) => {
  return await dns.lookup(hostname, { all: true, verbatim: true })
}

/**
 * Single DNS resolution + ALL-record IP validation (rejects if ANY returned A/AAAA record is non-public).
 * Returns the pinned public IP to dial directly, eliminating DNS rebinding TOCTOU.
 */
export async function resolveAndPinPublicIp(
  hostname: string,
  resolver: DnsResolverFn = defaultResolver,
): Promise<{ readonly ip: string; readonly family: 4 | 6 }> {
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (ipaddr.isValid(bare)) {
    const check = checkIpSafety(bare)
    if (!check.allowed) throw new Error(check.reason)
    return { ip: bare, family: bare.includes(':') ? 6 : 4 }
  }
  const records = await resolver(bare)
  if (records.length === 0) {
    throw new Error(`DNS returned no records for ${bare}`)
  }
  for (const rec of records) {
    const check = checkIpSafety(rec.address)
    if (!check.allowed) {
      throw new Error(`DNS record for ${bare} resolved to blocked address ${rec.address}: ${check.reason}`)
    }
  }
  const first = records[0]!
  return { ip: first.address, family: first.family === 6 ? 6 : 4 }
}

export interface ControlledProxyHandle {
  readonly port: number
  readonly proxyUrl: string
  readonly authHeaderValue: string
  readonly username: string
  readonly password: string
  close(): Promise<void>
}

/**
 * Start a temporary `127.0.0.1:0` controlled HTTP/HTTPS-CONNECT proxy requiring per-session
 * random `Proxy-Authorization`, rejecting private/loopback/CGNAT/IPv6-internal targets and
 * pinning the validated public IP on direct TCP dials.
 */
export async function startControlledFetchProxy(options: {
  readonly resolver?: DnsResolverFn
  readonly blockedLocalPorts?: readonly number[]
  readonly upstreamProxyUrl?: string
} = {}): Promise<ControlledProxyHandle> {
  const username = `dsh_${randomBytes(6).toString('hex')}`
  const password = randomBytes(18).toString('hex')
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const blockedLocal = new Set(options.blockedLocalPorts ?? [])

  if (options.upstreamProxyUrl) {
    const up = new URL(options.upstreamProxyUrl)
    const upPort = Number.parseInt(up.port || (up.protocol === 'https:' ? '443' : '80'), 10)
    if ((up.hostname === '127.0.0.1' || up.hostname === 'localhost' || up.hostname === '::1') && blockedLocal.has(upPort)) {
      throw new Error(`Upstream proxy port ${upPort} collides with local dsh/Studio/preview Host port`)
    }
  }

  const checkProxyAuth = (headers: http.IncomingHttpHeaders): boolean => {
    const raw = headers['proxy-authorization']
    return typeof raw === 'string' && raw === expectedAuth
  }

  const server = http.createServer(async (req, res) => {
    if (!checkProxyAuth(req.headers)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="dsh-self-fetch"' })
      res.end('Proxy Authentication Required')
      return
    }
    try {
      const targetUrl = req.url ?? ''
      const { url, hostname, port } = validateUrlSyntaxAndPort(targetUrl)
      const pinned = await resolveAndPinPublicIp(hostname, options.resolver)
      const forwardHeaders = { ...req.headers }
      delete forwardHeaders['proxy-authorization']
      delete forwardHeaders['proxy-connection']
      forwardHeaders.host = url.host

      const transport = url.protocol === 'https:' ? https : http
      const upstream = transport.request({
        host: pinned.ip,
        port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: forwardHeaders,
        servername: hostname,
        timeout: 15_000,
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      })
      upstream.on('error', (err) => {
        res.writeHead(502)
        res.end(`Upstream error: ${err.message}`)
      })
      req.pipe(upstream)
    } catch (error) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`SSRF/Proxy Blocked: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.on('connect', async (req, clientSocket, head) => {
    if (!checkProxyAuth(req.headers)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dsh-self-fetch"\r\n\r\n')
      clientSocket.destroy()
      return
    }
    try {
      const authority = req.url ?? ''
      const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority)
      if (!match?.[1] || !match[2]) {
        throw new Error(`Invalid CONNECT authority: ${authority}`)
      }
      const hostname = match[1].toLowerCase()
      const port = Number.parseInt(match[2], 10)
      if (!ALLOWED_PORTS.has(port)) {
        throw new Error(`Blocked CONNECT port ${port}`)
      }
      if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
        throw new Error(`Blocked internal hostname: ${hostname}`)
      }
      const pinned = await resolveAndPinPublicIp(hostname, options.resolver)
      const upstreamSocket = net.connect({ host: pinned.ip, port, family: pinned.family }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstreamSocket.write(head)
        upstreamSocket.pipe(clientSocket)
        clientSocket.pipe(upstreamSocket)
      })
      upstreamSocket.setTimeout(15_000, () => { upstreamSocket.destroy() })
      upstreamSocket.on('error', () => { clientSocket.destroy() })
      clientSocket.on('error', () => { upstreamSocket.destroy() })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      clientSocket.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nSSRF/Proxy Blocked: ${msg}`)
      clientSocket.destroy()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const addr = server.address() as net.AddressInfo
  return {
    port: addr.port,
    proxyUrl: `http://127.0.0.1:${addr.port}`,
    authHeaderValue: expectedAuth,
    username,
    password,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

export interface SafeFetchPageResult {
  readonly finalUrl: string
  readonly status: number
  readonly redirectsFollowed: number
  readonly title: string
  readonly themeColorHex: string | null
  readonly headings: readonly string[]
  readonly bodyBytes: number
}

/**
 * Hop-by-hop pinned-IP safe HTTP(S) fetch verifying EVERY redirect hop (including HTTPS 30x!)
 * with strict max redirects, max body size, and timeout — zero dependency on Electron main process.
 */
export async function safeFetchReferenceUrl(
  rawUrl: string,
  options: {
    readonly resolver?: DnsResolverFn
    readonly maxRedirects?: number
    readonly maxBodyBytes?: number
    readonly timeoutMs?: number
    readonly allowInsecureLocalTestPort?: number
  } = {},
): Promise<SafeFetchPageResult> {
  const maxRedirects = options.maxRedirects ?? 5
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024
  const timeoutMs = options.timeoutMs ?? 12_000
  let currentUrl = rawUrl
  let redirects = 0

  for (;;) {
    const { url, hostname, port } = validateUrlSyntaxAndPort(currentUrl)
    const pinned = await resolveAndPinPublicIp(hostname, options.resolver)

    const response = await new Promise<{ status: number; location?: string; body: string; bytes: number }>((resolve, reject) => {
      const isHttps = url.protocol === 'https:'
      const req = (isHttps ? https : http).request({
        host: pinned.ip,
        port,
        family: pinned.family,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: {
          Host: url.host,
          'User-Agent': 'dsh-self-studio/0.1 (reference-inspector)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
        servername: isHttps ? hostname : undefined,
        createConnection: isHttps
          ? (opts, cb) => {
              const sock = tls.connect({
                host: pinned.ip,
                port,
                servername: hostname,
                rejectUnauthorized: true,
              })
              if (cb) sock.once('secureConnect', () => { cb(null, sock) })
              return sock
            }
          : undefined,
      }, (res) => {
        const status = res.statusCode ?? 0
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined
        if (status >= 300 && status < 400 && location) {
          res.resume()
          resolve({ status, location, body: '', bytes: 0 })
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength
          if (total > maxBodyBytes) {
            req.destroy(new Error(`Response body exceeded ${maxBodyBytes} bytes`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({ status, body: Buffer.concat(chunks).toString('utf8'), bytes: total })
        })
      })
      req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Fetch timed out after ${timeoutMs}ms`)) })
      req.on('error', reject)
      req.end()
    })

    if (response.status >= 300 && response.status < 400 && response.location) {
      redirects += 1
      if (redirects > maxRedirects) {
        throw new Error(`Exceeded maximum redirect hops (${maxRedirects})`)
      }
      currentUrl = new URL(response.location, url).href
      continue
    }

    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(response.body)
    const themeColorMatch = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{6})["']/i.exec(response.body)
    const headings: string[] = []
    const hRe = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi
    let hm: RegExpExecArray | null
    while ((hm = hRe.exec(response.body)) !== null && headings.length < 8) {
      const clean = (hm[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 48)
      if (clean.length > 0) headings.push(clean)
    }

    return {
      finalUrl: url.href,
      status: response.status,
      redirectsFollowed: redirects,
      title: (titleMatch?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 64),
      themeColorHex: themeColorMatch?.[1] ?? null,
      headings,
      bodyBytes: response.bytes,
    }
  }
}
