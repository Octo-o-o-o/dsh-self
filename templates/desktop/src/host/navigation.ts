import { fileURLToPath } from 'node:url'
import path from 'node:path'

export interface ReadyUrl {
  readonly label: string
  readonly url: string
}

const READY_LINE = /^(.+?):\s+(https?:\/\/\S+)$/

export function parseReadyLine(line: string): ReadyUrl | null {
  const match = READY_LINE.exec(line.trim())
  if (match === null || !match[1] || !match[2]) return null
  try {
    const parsed = new URL(match[2])
    const token = parsed.searchParams.get('token')
    if (token === null || token.length === 0) return null
  } catch {
    return null
  }
  return { label: match[1], url: match[2] }
}

export class ReadyLineBuffer {
  private pending = ''

  push(chunk: string): ReadyUrl | null {
    this.pending += chunk
    const lines = this.pending.split(/\r?\n/)
    this.pending = lines.pop() ?? ''
    for (const line of lines) {
      const ready = parseReadyLine(line)
      if (ready !== null) return ready
    }
    return null
  }
}

export function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function assertReadyOrigin(url: string, port: number): string {
  const expected = `http://127.0.0.1:${port}`
  const parsed = new URL(url)
  if (parsed.origin !== expected) {
    throw new Error(`ready URL origin ${parsed.origin} is not ${expected}`)
  }
  return expected
}

function isAbout(url: string, name: 'blank' | 'srcdoc'): boolean {
  if (url === `about:${name}` || url.startsWith(`about:${name}#`)) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'about:' && (parsed.pathname === name || parsed.pathname === `/${name}`)
  } catch {
    return false
  }
}

export function allowTopNavigation(url: string, hostOrigin: string | undefined, loadingFile: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return path.normalize(fileURLToPath(parsed)) === path.normalize(loadingFile)
    }
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return false
    return hostOrigin !== undefined && parsed.origin === hostOrigin
  } catch {
    return false
  }
}

export function allowFrameNavigation(url: string, hostOrigin: string | undefined, loadingFile: string): boolean {
  if (isAbout(url, 'blank') || isAbout(url, 'srcdoc')) return true
  return allowTopNavigation(url, hostOrigin, loadingFile)
}
