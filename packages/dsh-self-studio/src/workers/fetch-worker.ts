/**
 * Independent child-process worker for SSRF/DNS-rebinding hardened reference URL fetching.
 * Invoked by `dsh-self-studio` Host via `child_process.spawn` with minimal env whitelist,
 * ensuring identical behavior under official `dsh web` AND official `dsh` Desktop.
 */
import { safeFetchReferenceUrl } from '../host/safe-fetch-proxy.js'

interface FetchWorkerInput {
  readonly url: string
  readonly maxRedirects?: number
  readonly maxBodyBytes?: number
  readonly timeoutMs?: number
}

async function readStdinJson(): Promise<FetchWorkerInput> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FetchWorkerInput
}

async function main(): Promise<void> {
  try {
    const input = await readStdinJson()
    const result = await safeFetchReferenceUrl(input.url, {
      maxRedirects: input.maxRedirects,
      maxBodyBytes: input.maxBodyBytes,
      timeoutMs: input.timeoutMs,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, value: result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`)
    process.exitCode = 1
  }
}

void main()
