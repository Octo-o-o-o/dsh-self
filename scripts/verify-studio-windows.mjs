// Drive a release-format Studio inside the pinned dsh Host and verify both browser downloads.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidence = path.resolve(process.env.DSH_SELF_ACCEPTANCE_DIR || path.join(root, '.dev/studio-acceptance'))
mkdirSync(evidence, { recursive: true })
const run = mkdtempSync(path.join(evidence, 'author-'))
const base = process.env.DSH_SELF_BASE_SHELL_DIR || path.join(root, '.dev/base-shell/win32-x64')
const runtime = path.join(base, 'resources/runtime')
const home = path.join(run, 'dsh-home')
const dataDir = path.join(run, 'projects')
const profile = path.join(home, 'profiles/web')
const workspace = path.join(run, 'workspace')
mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
mkdirSync(workspace)
const installedPlugin = path.join(profile, 'node_modules/dsh-self-studio')
mkdirSync(installedPlugin)
const archiveSource = process.env.DSH_SELF_STUDIO_TARBALL || path.join(root, '.dev/studio-bundle/dsh-self-studio-0.1.0.tgz')
const studioArchive = path.join(run, path.basename(archiveSource))
copyFileSync(archiveSource, studioArchive)
const studioSha256 = createHash('sha256').update(readFileSync(studioArchive)).digest('hex')
execFileSync('tar.exe', ['-xzf', studioArchive, '-C', installedPlugin, '--strip-components', '1'])
writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true, dependencies: { 'dsh-self-studio': '0.1.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-self-studio'] } },
}))
writeFileSync(path.join(profile, 'cordis.yml'), '[]\n')
writeFileSync(path.join(profile, 'cordis.patch.yml'), [
  '- id: ui-settings-general', '  config:', "    welcomeNoticeVersion: '2026-09-28.1'",
  '- id: session-log-deepseek', '  config:', '    enabled: false',
  '- id: workspace-controller', '  config:', '    documentsDirectory: ' + JSON.stringify(workspace),
  '- id: ui-settings-models', '  config:', '    credentialOnboarding: false', '',
].join('\n'))
writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
const host = spawn(process.execPath, [path.join(runtime, 'host-entry.js'), runtime, 'web', '0'], {
  stdio: ['ignore', 'pipe', 'ignore', 'ipc'], cwd: workspace, windowsHide: true,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_SELF_STUDIO_DATA_DIR: dataDir,
    DSH_SELF_BUILDER_CLI: path.join(root, 'tools/builder/dist/cli.js'), DSH_SELF_BASE_SHELL_DIR: base },
})
const hostExit = new Promise(resolve => host.once('exit', resolve))
const report = { run, base, dsh: '0.2.2-rc.5', studioArchive, studioSha256 }
let browser
let page
try {
  const readyUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dsh Host startup timed out')), 60000)
    const lines = createInterface({ input: host.stdout })
    lines.on('line', line => {
      const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w.%-]+/.exec(line)?.[0]
      if (url) { clearTimeout(timer); resolve(url) }
    })
    host.once('error', error => { clearTimeout(timer); reject(error) })
    host.once('exit', code => { clearTimeout(timer); reject(new Error('dsh Host exited ' + code)) })
  })
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  page = await browser.newPage({ acceptDownloads: true, locale: 'zh-CN' })
  await page.goto(readyUrl)
  await page.getByRole('button', { name: /Build My Client|制作我的客户端/i }).first().click()
  const intakeOnly = process.argv.includes('--intake-only')
  const prompt = intakeOnly ? '管理仓库库存和每日盘点' : '为我制作处理现有招标 DOCX、提取截止日和评分项、导出响应表的投标工作台'
  const textBox = page.getByPlaceholder(/随便写一句/)
  await textBox.fill(prompt)
  if (intakeOnly) {
    await page.getByRole('button', { name: /生成 3 套方案/ }).click()
    await page.getByText(/此需求还没有匹配到已交付的动作/).first().waitFor()
    await textBox.fill('')
    report.unmatchedInventory = true
    await page.locator('summary').filter({ hasText: '上传参考图' }).click()
  }
  const image = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#087ba1' } }).png().toBuffer()
  const referenceInput = page.locator('input[type=file][accept*="image"]').first()
  await referenceInput.setInputFiles({ name: '品牌参考.png', mimeType: 'image/png', buffer: image })
  if (intakeOnly) {
    const workflow = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: /Image annotation/ }) })
    await workflow.selectOption({ label: '图片批注 / Image annotation' })
  }
  await page.getByRole('button', { name: /生成 3 套方案/ }).click()
  if (intakeOnly) {
    await page.getByText('方案 B · 标准三栏设计台', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: /采用此方案/ }).click()
    await page.getByText('@dsh-self/adapter-design-canvas', { exact: true }).first().waitFor()
    assert.equal(await page.getByRole('button', { name: /查标讯/ }).count(), 0)
    report.imageOnlyDesign = true
    await page.screenshot({ path: path.join(run, 'design-selection.png') })
  } else {
    await page.getByText('方案 C · 投标全能看板版', { exact: true }).first().click()
    await page.getByRole('button', { name: /采用此方案/ }).click()
    await page.getByRole('button', { name: /移除 .*不可用的可选功能/ }).click()
    await page.getByText(/· r2$/, { exact: false }).first().waitFor()
    report.removedUnavailableOptional = true
    const steps = page.getByRole('navigation', { name: 'Studio steps' })
    await steps.getByRole('button', { name: /^5\./ }).click()
    await page.getByRole('button', { name: /Open desktop trial/ }).click()
    await page.getByText(/已打开桌面修订 r2/).waitFor({ timeout: 100000 })
    console.log('Studio loaded the reference and opened the real product window')
    await steps.getByRole('button', { name: /^6\./ }).click()
    const started = Date.now()
    await page.getByRole('button', { name: /打 v.* 包/ }).click()
    const link = page.getByRole('link', { name: /下载安装包/ })
    await Promise.race([
      link.waitFor({ timeout: 25 * 60000 }),
      page.getByRole('alert').first().waitFor({ timeout: 25 * 60000 }).then(async () => {
        throw new Error('Studio build error: ' + await page.getByRole('alert').first().innerText())
      }),
    ])
    report.buildSeconds = (Date.now() - started) / 1000
    async function download(link) {
      const pending = page.waitForEvent('download', { timeout: 180000 })
      await link.click()
      const download = await pending
      const target = path.join(run, path.basename(download.suggestedFilename()))
      await download.saveAs(target)
      return target
    }
    const receiptPath = await download(page.getByRole('link', { name: /下载构建回执/ }))
    const receipt = JSON.parse(readFileSync(receiptPath))
    const installer = await download(link)
    const hash = createHash('sha256')
    for await (const part of createReadStream(installer)) hash.update(part)
    const sha256 = hash.digest('hex')
    assert.equal(sha256, receipt.artifactSha256)
    assert.equal(statSync(installer).size, receipt.artifactBytes)
    const projectDir = path.join(dataDir, receipt.productId)
    const frozen = JSON.parse(readFileSync(path.join(path.dirname(receipt.artifactPath), 'inputs/product.json')))
    assert.equal(frozen.revision, receipt.revision)
    assert.equal(frozen.identity.productId, receipt.productId)
    assert.equal(frozen.theme.seeds.light.accent, '#087ba1')
    assert.equal(receipt.revision, 2)
    const original = path.join(projectDir, 'assets/originals', createHash('sha256').update(image).digest('hex'))
    assert.deepEqual(readFileSync(original), image)
    report.job = { jobId: receipt.jobId, installer, receiptPath, revision: receipt.revision,
      sha256, bytes: receipt.artifactBytes, accent: frozen.theme.seeds.light.accent, originalReference: path.basename(original) }
  }
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String(error).replace(/([?&]token=)[^&\s"']+/g, '$1[redacted]')
  if (page) report.visibleControls = await page.getByRole('button').allTextContents().catch(() => [])
  process.exitCode = 1
} finally {
  await browser?.close()
  if (host.connected) host.disconnect()
  const timer = setTimeout(() => host.kill(), 15000)
  try { await hostExit } finally { clearTimeout(timer) }
  writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
