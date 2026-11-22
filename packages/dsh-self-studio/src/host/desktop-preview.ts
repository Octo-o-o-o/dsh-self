import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { computeSpecDigest, PINNED_TEMPLATE_COMMIT, type PlatformLock, type ProductSpec } from '@dsh-self/product-spec'
import { ensureExternalPluginPayloads } from '../../../../tools/builder/src/external-plugins.js'
import { buildProfileSeed } from '../../../../tools/builder/src/seed-builder.js'
import { buildWhitelistedHostEnv } from '../../../../templates/desktop/src/host/env-whitelist.js'

export async function launchDesktopTrial(
  baseShell: string | undefined,
  projectDir: string,
  spec: ProductSpec,
  lock: PlatformLock,
  pluginCacheDir?: string,
) {
  const exe = baseShell && path.join(baseShell, 'electron.exe')
  if (process.platform !== 'win32' || !exe || !existsSync(exe)) {
    throw new Error('请先在 Studio 插件设置中配置 Windows baseShellDir / Configure the Windows base shell first')
  }
  const productDigest = computeSpecDigest(spec)
  const lockDigest = computeSpecDigest(lock)
  const key = computeSpecDigest([productDigest, lockDigest, PINNED_TEMPLATE_COMMIT])
  const trialRoot = path.join(projectDir, 'desktop-trial')
  const productDir = path.join(trialRoot, key, 'product')
  mkdirSync(productDir, { recursive: true })
  writeFileSync(path.join(productDir, 'product.json'), JSON.stringify(spec))
  writeFileSync(path.join(productDir, `plugins.${lock.target}.lock.json`), JSON.stringify(lock))
  await ensureExternalPluginPayloads(lock, pluginCacheDir ? { pluginCacheDir } : undefined)
  buildProfileSeed({ spec, lock, outDir: productDir, ...(pluginCacheDir ? { pluginCacheDir } : {}) })
  const child = spawn(exe, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    env: buildWhitelistedHostEnv({
      sourceEnv: process.env, dshHome: path.join(trialRoot, 'data', 'h'),
      extraAllowed: { DSH_SELF_PRODUCT_DIR: productDir, DSH_SELF_TRIAL_ROOT: trialRoot },
    }),
  })
  const stop = () => {
    if (child.connected) child.send({ type: 'close-trial' }, () => {})
  }
  const ready = new Promise<{ revision: number; productDigest: string; lockDigest: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('桌面试用启动超时 / Trial startup timed out')) }, 90_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`试用窗口已退出 / Trial exited (${code})`)) })
    child.on('message', msg => {
      const result = msg as { type?: string; detail?: string }
      if (result.type === 'trial-ready') {
        clearTimeout(timeout)
        resolve({ revision: spec.revision, productDigest, lockDigest })
      } else if (result.type === 'trial-error') {
        clearTimeout(timeout); stop(); reject(new Error(result.detail ?? 'Trial could not start'))
      }
    })
  })
  return { child, ready, stop, key }
}
