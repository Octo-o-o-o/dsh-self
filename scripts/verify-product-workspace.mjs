import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import sharp from 'sharp'
import { computeSpecDigest } from '../packages/product-spec/dist/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.DSH_SELF_BASE_SHELL_DIR || path.join(root, '.dev/base-shell/win32-x64')
const candidate = process.argv[2] && path.resolve(process.argv[2])
const evidence = path.resolve(process.env.DSH_SELF_ACCEPTANCE_DIR || path.join(root, '.dev/studio-acceptance'))
mkdirSync(evidence, { recursive: true })
const run = mkdtempSync(path.join(evidence, 'workspaces-'))
let packagedExe = candidate
let embeddedProduct
if (candidate?.endsWith('-win32-x64-setup.exe')) {
  const unpacked = path.join(run, 'payload')
  mkdirSync(unpacked)
  const require = createRequire(import.meta.url)
  const builder = createRequire(require.resolve('electron-builder'))
  const library = createRequire(builder.resolve('app-builder-lib'))
  const sevenZip = library.resolve('electron-winstaller/vendor/7z.exe')
  const extraction = ['-o' + unpacked, '-y']
  execFileSync(sevenZip, ['e', candidate, '$PLUGINSDIR\\app-64.7z', ...extraction], { stdio: 'ignore' })
  execFileSync(sevenZip, ['x', path.join(unpacked, 'app-64.7z'), ...extraction], { stdio: 'ignore' })
  const resources = path.join(unpacked, 'resources/product')
  const embedded = JSON.parse(readFileSync(path.join(resources, 'product.json')))
  const lock = JSON.parse(readFileSync(path.join(resources, 'plugins.win32-x64.lock.json')))
  const seed = JSON.parse(readFileSync(path.join(resources, 'seed-manifest.json')))
  packagedExe = path.join(unpacked, embedded.identity.executableName + '.exe')
  const handle = openSync(packagedExe, 'r')
  try {
    const header = Buffer.alloc(4096)
    readSync(handle, header, 0, header.length, 0)
    assert.equal(header.readUInt16LE(header.readUInt32LE(60) + 4), 0x8664)
  } finally { closeSync(handle) }
  embeddedProduct = { productId: embedded.identity.productId, revision: embedded.revision, executableMachine: 'AMD64',
    productDigest: computeSpecDigest(embedded), lockDigest: computeSpecDigest(lock), seedHash: seed.seedHash }
  const receiptFile = path.join(path.dirname(candidate), 'build-receipt.json')
  if (existsSync(receiptFile)) {
    const receipt = JSON.parse(readFileSync(receiptFile))
    for (const field of ['productId', 'revision', 'productDigest', 'lockDigest', 'seedHash']) assert.equal(embeddedProduct[field], receipt[field])
  }

}
const report = { run, source: candidate, packagedExe, embeddedProduct, products: {} }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function open(kind) {
  const exe = kind === 'bid' && packagedExe ? packagedExe : path.join(base, 'electron.exe')
  const productDir = exe === packagedExe ? path.join(path.dirname(exe), 'resources/product')
    : path.join(root, 'fixtures', kind === 'bid' ? 'qinghe-bids' : 'qinghe-design')
  const spec = JSON.parse(readFileSync(path.join(productDir, 'product.json')))
  const trialRoot = path.join(run, kind)
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    env: { ...process.env, DSH_HOME: path.join(trialRoot, 'data/h'), DSH_SELF_TRIAL_ROOT: trialRoot, DSH_SELF_PRODUCT_DIR: productDir },
  })
  const exit = new Promise(resolve => child.once('exit', resolve))
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.connected) child.send({ type: 'close-trial' }, () => {})
    const timer = setTimeout(() => child.kill(), 15000)
    try { await exit } finally { clearTimeout(timer) }
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron debugging endpoint timed out')), 30000)
      const lines = createInterface({ input: child.stderr })
      lines.on('line', line => {
        const url = /DevTools listening on (ws:\/\/\S+)/.exec(line)?.[1]
        if (url) { clearTimeout(timer); resolve(url) }
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Electron exited ' + code)) })
    })
    const browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    const page = context.pages()[0] || await context.waitForEvent('page')
    await page.locator('[data-dsh-product-ready="' + spec.identity.productId + '"]').waitFor({ timeout: 70000 })
    await page.getByLabel(kind === 'bid' ? /Import DOCX/ : /Import image/).waitFor()
    return { page, close, spec }
  } catch (error) { await close(); throw error }
}

async function exportedBytes(page, button, name) {
  await page.getByRole('button', { name: button }).click()
  const link = page.locator('a[download="' + name + '"]')
  await link.waitFor()
  const value = await link.getAttribute('href')
  const bytes = Buffer.from(value.split(',')[1], 'base64')
  const saved = await page.locator('[data-saved-path]').getAttribute('data-saved-path')
  assert.deepEqual(readFileSync(saved), bytes)
  return { bytes, saved }
}

async function checkBid(page, index) {
  const date = '2027-03-' + (21 + index)
  await page.locator('[data-section="deadlines"]').getByText(date, { exact: false }).waitFor()
  await page.locator('[data-section="missing-materials"]').getByText(/ISO/).waitFor()
  const { bytes, saved } = await exportedBytes(page, /Export DOCX/, 'response.docx')
  const xml = strFromU8(unzipSync(bytes)['word/document.xml'])
  assert.ok(xml.includes(date) && xml.includes('评分') && xml.includes('ISO'))
  assert.ok(xml.includes('待填写逐条响应及证明材料') && !xml.includes('我方完全满足'))
  return { date, saved, sha256: digest(bytes), documentXmlSha256: digest(xml) }
}

async function checkDesign(page, note, index) {
  await page.locator('[data-section="annotations-panel"]').getByText(note, { exact: true }).waitFor()
  const { bytes, saved } = await exportedBytes(page, /Export PNG/, 'annotated.png')
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 240)
  assert.equal(info.height, 160)
  let red = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100) red++
  }
  assert.ok(red > 10, 'Rendered PNG includes the annotation badge')
  return { index, note, saved, sha256: digest(bytes) }
}

async function exercise(kind) {
  let app = await open(kind)
  const ids = []
  const outputs = []
  try {
    const { page, spec } = app
    const input = page.getByLabel(kind === 'bid' ? /Import DOCX/ : /Import image/)
    for (let i = 0; i < 2; i++) {
      let buffer
      if (kind === 'bid') {
        const files = unzipSync(readFileSync(path.join(root, 'fixtures/docx/valid-bid.docx')))
        files['word/document.xml'] = strToU8(strFromU8(files['word/document.xml']).replace('2026-12-20', '2027-03-' + (21 + i)))
        buffer = Buffer.from(zipSync(files))
      } else {
        buffer = await sharp({ create: { width: 240, height: 160, channels: 3, background: i ? '#8dbabb' : '#a5d6a7' } }).png().toBuffer()
      }
      const filename = kind === 'bid' ? '同名标书.docx' : '同名设计.png'
      await input.setInputFiles({ name: filename, mimeType: kind === 'bid' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'image/png', buffer })
      const files = page.getByLabel(/Saved files/)
      await files.locator('option').nth(i).waitFor({ state: 'attached' })
      ids.push(await files.inputValue())
      if (kind === 'bid') outputs.push(await checkBid(page, i))
      else {
        const image = page.getByRole('img', { name: filename, exact: true })
        await image.waitFor()
        const note = '第' + (i + 1) + '张的审阅意见'
        await page.getByLabel(/批注 \/ Note/).fill(note)
        await image.click({ position: { x: 55 + i * 25, y: 45 } })
        await page.getByRole('button', { name: /Save notes/ }).click()
        await page.getByText(/Annotations saved/).waitFor()
        outputs.push(await checkDesign(page, note, i))
      }
    }
    assert.notEqual(ids[0], ids[1])
    assert.notEqual(outputs[0].saved, outputs[1].saved)
    assert.notEqual(outputs[0].sha256, outputs[1].sha256)
    await app.close()
    app = await open(kind)
    const files = app.page.getByLabel(/Saved files/)
    for (const [index, id] of ids.entries()) {
      await files.selectOption(id)
      const reopened = kind === 'bid' ? await checkBid(app.page, index) : await checkDesign(app.page, outputs[index].note, index)
      assert.equal(reopened.saved, outputs[index].saved)
      if (kind === 'bid') assert.equal(reopened.documentXmlSha256, outputs[index].documentXmlSha256)
      else assert.equal(reopened.sha256, outputs[index].sha256)
      outputs[index] = { ...reopened, firstExportSha256: outputs[index].sha256 }
    }
    const screenshot = path.join(run, kind + '.png')
    await app.page.screenshot({ path: screenshot })
    report.products[kind] = { productId: spec.identity.productId, ids, outputs, screenshot, reopened: true }
  } finally { await app.close() }
}

try {
  await exercise('bid')
  await exercise('design')
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String(error)
  process.exitCode = 1
} finally {
  writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
