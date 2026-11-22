import { createHash } from 'node:crypto'
import { open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  BuildReceiptSchema, computeSpecDigest, PINNED_TEMPLATE_COMMIT,
  type BuildReceipt, type PlatformLock, type ProductSpec,
} from '@dsh-self/product-spec'

/** Verify the output of this exact Windows builder job before exposing a download. */
export async function verifyWindowsInstaller(
  outDir: string, jobId: string, spec: ProductSpec, lock: PlatformLock,
): Promise<BuildReceipt> {
  const receipt = BuildReceiptSchema.parse(JSON.parse(await readFile(path.join(outDir, 'build-receipt.json'), 'utf8')))
  const productDigest = computeSpecDigest(spec)
  const lockDigest = computeSpecDigest(lock)
  const expected = {
    productId: spec.identity.productId, revision: spec.revision, target: lock.target,
    productDigest, lockDigest, templateCommit: PINNED_TEMPLATE_COMMIT,
  }
  const fileName = `${spec.identity.internalSlug}-${spec.appVersion}-win32-x64-setup.exe`
  const expectedPath = path.join(await realpath(outDir), fileName)
  if (receipt.jobId !== jobId || receipt.appVersion !== spec.appVersion ||
      receipt.dedupKey !== computeSpecDigest(expected) || receipt.target !== 'win32-x64' ||
      receipt.distributionStatus !== 'unsigned-local-test' ||
      Object.entries(expected).some(([key, value]) => receipt[key as keyof BuildReceipt] !== value) ||
      path.relative(expectedPath, await realpath(receipt.artifactPath)) !== '') {
    throw new Error('安装包回执与本次任务、修订或目标文件不符 / Build receipt mismatch')
  }
  const file = await open(expectedPath, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== receipt.artifactBytes) throw new Error('安装包大小校验失败 / Size mismatch')
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const pe = bytesRead >= 64 ? header.readUInt32LE(60) : 0
    const nsis = Buffer.from('efbeadde4e756c6c736f6674496e7374', 'hex')
    if (header.toString('ascii', 0, 2) !== 'MZ' || pe < 64 || pe + 4 > bytesRead ||
        header.readUInt32LE(pe) !== 0x4550 || header.subarray(pe + 4, bytesRead).indexOf(nsis) < 0) {
      throw new Error('文件格式不是预期的 Windows NSIS 安装包 / Invalid installer format')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) throw new Error('安装包读取中断 / Incomplete installer')
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (digest.digest('hex') !== receipt.artifactSha256) throw new Error('安装包 SHA-256 校验失败 / Hash mismatch')
    return receipt
  } finally {
    await file.close()
  }
}
