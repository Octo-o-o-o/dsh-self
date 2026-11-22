#!/usr/bin/env node
/**
 * Independent trust-root CLI for building standalone dsh-self clients.
 * Usage:
 *   node tools/builder/dist/cli.js \
 *     --product <product.json> \
 *     --lock <locks/plugins.<target>.lock.json> \
 *     --target <win32-x64|linux-x64|darwin-arm64|darwin-x64> \
 *     --out <output-dir> \
 *     [--base-shell <base-shell-dir>] [--job-id <id>] [--icon <png/svg>] [--seed-salt <salt>]
 */
import type { SupportedTarget } from '@dsh-self/product-spec'
import { runClientBuild } from './index.js'

function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg.startsWith('--') && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[i + 1]!
      i += 1
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const productPath = args.product
  const lockPath = args.lock
  const target = (args.target ?? 'win32-x64') as SupportedTarget
  const outDir = args.out
  if (!productPath || !lockPath || !outDir) {
    throw new Error('Usage: --product <file> --lock <file> --target <target> --out <dir> [--base-shell <dir>]')
  }
  console.log(`[dsh-self-builder] Building ${target} from ${productPath} ...`)
  const receipt = await runClientBuild({
    productPath,
    lockPath,
    target,
    outDir,
    baseShellDir: args['base-shell'],
    jobId: args['job-id'],
    iconSourcePath: args.icon,
    extraSeedSalt: args['seed-salt'],
  })
  console.log(`[dsh-self-builder] Built artifact: ${receipt.artifactPath}`)
  console.log(`[dsh-self-builder] SHA-256:        ${receipt.artifactSha256}`)
  console.log(`[dsh-self-builder] SeedHash:       ${receipt.seedHash}`)
}

void main().catch((error) => {
  console.error(`[dsh-self-builder] ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
