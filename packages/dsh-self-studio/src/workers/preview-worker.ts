/**
 * Independent 1:1 preview child-process worker.
 * Renders the branded standalone desktop client shell 1:1 (window header, left sidebar nav,
 * workspace footer, readiness notice, controlled home layout, AI chat placeholder,
 * read-only installed extensions view, and settings view) with live SSE hot-refresh.
 */
import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ProductSpecSchema,
  WIDGET_CATALOG,
  deriveThemeTokens,
  escapeHtml,
  type ProductSpec,
} from '@dsh-self/product-spec'
import {
  analyzeBidDocument,
  buildBidResponseDocx,
  parseAndSanitizeDocx,
  verifyExportedDocx,
} from '@dsh-self/adapters/bid-docx'
import { zipSync, strToU8 } from 'fflate'

interface PreviewWorkerConfig {
  readonly projectId: string
  readonly previewDir: string
  readonly specPath: string
  readonly preferredPort?: number
}

function readConfig(): PreviewWorkerConfig {
  const arg = process.argv[2]
  if (!arg) throw new Error('preview-worker requires config JSON path as argv[2]')
  return JSON.parse(readFileSync(arg, 'utf8')) as PreviewWorkerConfig
}

function createSampleBidDocx(): Uint8Array {
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p w14:paraId="00000001"><w:r><w:t>青禾智慧园区信息化项目招标文件（预览样例）</w:t></w:r></w:p>
    <w:p w14:paraId="00000002"><w:r><w:t>投标文件递交截止时间：2026-12-18 14:00，逾期拒收。</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p w14:paraId="00000003"><w:r><w:t>技术方案评分标准：架构完整且支持国产化部署（35分）</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p w14:paraId="00000004"><w:r><w:t>售后服务评分标准：7×24小时本地响应承诺（15分）</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p w14:paraId="00000005"><w:r><w:t>投标人须提供有效 ISO 27001 信息安全管理体系资质证书复印件。</w:t></w:r></w:p>
  </w:body>
</w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(docXml),
  })
}

function renderPreviewHtml(spec: ProductSpec, revisionNonce: number): string {
  const derived = deriveThemeTokens(spec.theme.seeds)
  const l = derived.clampedSeeds.light
  const d = derived.clampedSeeds.dark
  const titleZh = escapeHtml(spec.brand.displayName.zh)
  const titleEn = escapeHtml(spec.brand.displayName.en)
  const slug = escapeHtml(spec.identity.internalSlug)
  const safeIconUrl =
    spec.brand.iconDataUrl && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(spec.brand.iconDataUrl)
      ? spec.brand.iconDataUrl
      : null

  const iconEl = safeIconUrl
    ? `<img class="mark" src="${safeIconUrl}" alt="${titleZh}" />`
    : `<div class="mark fallback">${escapeHtml(spec.brand.displayName.zh.slice(0, 1))}</div>`

  const sectionsHtml = spec.home.sections
    .map((secId, idx) => {
      const meta = WIDGET_CATALOG[secId]
      const customLabel = spec.home.sectionLabels?.[secId]
      const label = escapeHtml(customLabel ?? meta.title.zh)
      let body = ''
      if (secId === 'deadlines') {
        body = `<div class="item"><strong>2026-12-18 14:00</strong><span>青禾智慧园区信息化项目 · 距截止 26 天</span><span class="tag">第 2 段</span></div>`
      } else if (secId === 'missing-materials') {
        body = `<div class="item warn"><strong>待补齐</strong><span>ISO 27001 信息安全管理体系资质证书</span><span class="tag">第 5 段</span></div>`
      } else if (secId === 'bid-preview') {
        body = `<div class="preview-box"><p class="muted">支持本地导入招标 DOCX、标出评分项并导出逐条响应表。</p><button class="btn" id="run-bid-sample">运行样例并导出响应表</button><pre id="sample-out" class="out"></pre></div>`
      } else if (secId === 'project-list') {
        body = `<div class="item"><strong>主视觉海报 v2</strong><span>3 处批注 · 已自动校正方向</span></div><div class="item"><strong>超长详情页样例</strong><span>2000×40000 流畅预览</span></div>`
      } else if (secId === 'design-canvas') {
        body = `<div class="canvas-stage" id="canvas-stage"><div class="pin" style="left:28%;top:32%">1</div><div class="pin" style="left:64%;top:58%">2</div><p class="muted">点击画布任意位置添加批注点</p></div>`
      } else if (secId === 'annotations-panel') {
        body = `<div id="ann-list"><div class="item"><strong>#1</strong><span>主标题加深对比度</span></div><div class="item"><strong>#2</strong><span>按钮对齐主栅格</span></div></div>`
      } else if (secId === 'recent-sessions') {
        body = `<div class="item"><strong>上次处理记录</strong><span>点击继续未完成的任务或导出草稿</span></div>`
      } else if (secId === 'connections-card') {
        body = `<div class="item"><strong>本地运行模式</strong><span>无需外网账号即可处理本地文件，可按需接入模型/MCP</span></div>`
      } else if (secId === 'readiness-bar') {
        body = `<div class="item"><strong>运行环境正常</strong><span>独立数据目录已就绪</span></div>`
      } else {
        body = `<p class="muted">${escapeHtml(meta.title.zh)}</p>`
      }
      return `<section class="card" data-section="${escapeHtml(secId)}" data-order="${idx}"><header class="card-hd"><h3>${label}</h3><span class="pill">#${idx + 1}</span></header>${body}</section>`
    })
    .join('\n')

  const capabilityRows = [...spec.requiredActions, ...spec.optionalActions]
    .map((a) => `<div class="item"><strong>${escapeHtml(a)}</strong><span class="muted">已内置并随客户端锁定（只读）</span></div>`)
    .join('')

  const layoutClass = escapeHtml(spec.home.layout)
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<title>${titleZh} v${escapeHtml(spec.appVersion)}</title>
${safeIconUrl ? `<link rel="icon" href="${safeIconUrl}" />` : ''}
<style>
:root {
  --bg: ${l.canvas}; --surface: ${l.surface}; --ink: ${l.ink}; --muted: ${l.mutedInk};
  --accent: ${l.accent}; --border: ${l.border}; --danger: ${l.danger}; --ok: ${l.ok};
  --sidebar-bg: color-mix(in srgb, var(--surface) 92%, var(--ink) 4%);
}
html[data-theme="dark"] {
  --bg: ${d.canvas}; --surface: ${d.surface}; --ink: ${d.ink}; --muted: ${d.mutedInk};
  --accent: ${d.accent}; --border: ${d.border}; --danger: ${d.danger}; --ok: ${d.ok};
  --sidebar-bg: color-mix(in srgb, var(--surface) 94%, #000 6%);
}
* { box-sizing: border-box; }
body { margin: 0; font: 13.5px/1.5 "Segoe UI", system-ui, sans-serif; background: var(--bg); color: var(--ink); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
/* 1:1 Desktop window titlebar */
.winbar { height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--surface); user-select: none; flex-shrink: 0; }
.win-brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
.mark { width: 20px; height: 20px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
.mark.fallback { background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 11px; }
.win-right { display: flex; align-items: center; gap: 8px; }
.win-dots { display: flex; gap: 6px; margin-left: 8px; opacity: 0.6; font-size: 12px; }
/* 1:1 App shell: Left sidebar + Main content */
.app-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 200px 1fr; overflow: hidden; }
@media (max-width: 720px) { .app-shell { grid-template-columns: 156px 1fr; } }
.sidebar { border-right: 1px solid var(--border); background: var(--sidebar-bg); display: flex; flex-direction: column; padding: 10px 8px; gap: 6px; overflow-y: auto; }
.side-hero { display: flex; align-items: center; gap: 9px; padding: 6px 8px 10px; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
.side-hero .mark { width: 30px; height: 30px; border-radius: 8px; }
.side-title { display: flex; flex-direction: column; min-width: 0; }
.side-title strong { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-title span { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nav-btn { width: 100%; text-align: left; border: 0; background: transparent; color: var(--ink); padding: 8px 10px; border-radius: 8px; cursor: pointer; font: inherit; display: flex; align-items: center; gap: 8px; }
.nav-btn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.nav-btn.active { background: var(--accent); color: #fff; font-weight: 600; }
.side-section { margin-top: 8px; padding: 8px 8px 0; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
.ws-pill { margin-top: 4px; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--surface); font-size: 11.5px; color: var(--ink); word-break: break-all; }
.side-spacer { flex: 1; }
/* Main panel */
.main { overflow-y: auto; display: flex; flex-direction: column; min-width: 0; }
.readiness { margin: 12px 16px 0; padding: 8px 12px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
.grid { padding: 14px 16px; display: grid; gap: 12px; }
.grid.single-column { grid-template-columns: 1fr; max-width: 780px; margin: 0 auto; width: 100%; }
.grid.list-detail { grid-template-columns: 260px 1fr; }
.grid.three-pane { grid-template-columns: 180px 1fr 210px; }
.grid.dashboard-grid { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
@media (max-width: 720px) { .grid.list-detail, .grid.three-pane { grid-template-columns: 1fr; } }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.card-hd { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.card-hd h3 { margin: 0; font-size: 14px; }
.item { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 7px; margin-bottom: 8px; }
.item.warn { border-left: 3px solid var(--danger); }
.tag { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
.pill { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.pill.ok { border-color: var(--ok); color: var(--ok); }
.btn { border: 0; background: var(--accent); color: #fff; padding: 6px 11px; border-radius: 7px; cursor: pointer; font-weight: 600; font-size: 12.5px; }
.btn.ghost { background: transparent; color: var(--ink); border: 1px solid var(--border); }
.muted { color: var(--muted); margin: 3px 0 6px; font-size: 12.5px; }
.out { margin: 8px 0 0; padding: 8px; border-radius: 7px; background: var(--bg); border: 1px solid var(--border); font-size: 11.5px; white-space: pre-wrap; max-height: 150px; overflow: auto; display: none; }
.canvas-stage { position: relative; height: 190px; border-radius: 8px; border: 1px dashed var(--border); background: var(--bg); display: grid; place-items: center; cursor: crosshair; }
.pin { position: absolute; width: 22px; height: 22px; border-radius: 999px; background: var(--danger); color: #fff; font-weight: 700; font-size: 11px; display: grid; place-items: center; transform: translate(-50%,-50%); box-shadow: 0 2px 6px rgba(0,0,0,.25); }
.view-pane { display: none; padding: 14px 16px; }
.view-pane.active { display: block; }
</style>
</head>
<body data-revision="${spec.revision}" data-reload="${revisionNonce}">
  <header class="winbar">
    <div class="win-brand">
      ${iconEl}
      <span>${titleZh}</span>
      <span class="pill">v${escapeHtml(spec.appVersion)}</span>
    </div>
    <div class="win-right">
      <span class="pill ok">本地就绪</span>
      <button class="btn ghost" id="toggle-theme" style="padding:3px 8px;font-size:11.5px;">明/暗</button>
      <div class="win-dots" aria-hidden="true"><span>─</span><span>□</span><span>×</span></div>
    </div>
  </header>

  <div class="app-shell">
    <aside class="sidebar" aria-label="客户端侧边栏">
      <div class="side-hero">
        ${iconEl}
        <div class="side-title">
          <strong>${titleZh}</strong>
          <span>${titleEn}</span>
        </div>
      </div>

      <button type="button" class="nav-btn active" data-nav="home">🏠 工作台首页</button>
      <button type="button" class="nav-btn" data-nav="chat">💬 AI 助手</button>
      <button type="button" class="nav-btn" data-nav="plugins">🧩 已装能力</button>
      <button type="button" class="nav-btn" data-nav="settings">⚙️ 设置与模型</button>

      <div class="side-section">
        <div>当前工作区</div>
        <div class="ws-pill">📁 ${slug}</div>
      </div>

      <div class="side-spacer"></div>
      <div class="side-section">
        <div>独立数据目录 · 修订 r${spec.revision}</div>
      </div>
    </aside>

    <main class="main">
      <div id="pane-home" class="view-pane active" style="padding:0;">
        ${spec.shell.showReadinessBar ? `<div class="readiness"><span>本地功能立即可用；如需 AI 辅助，可在左侧「设置与模型」填写密钥。</span><button class="btn ghost" data-jump="settings" style="padding:4px 9px;font-size:12px;">去配置模型</button></div>` : ''}
        <div class="grid ${layoutClass}">
          ${sectionsHtml}
        </div>
      </div>

      <div id="pane-chat" class="view-pane">
        <div class="card">
          <div class="card-hd"><h3>AI 助手会话</h3><span class="pill">未配置模型密钥</span></div>
          <p class="muted">配置模型后，可直接让助手总结文件、起草响应或生成批注建议。</p>
          <button class="btn" data-jump="settings">前往配置模型</button>
        </div>
      </div>

      <div id="pane-plugins" class="view-pane">
        <div class="card">
          <div class="card-hd"><h3>已装能力</h3><span class="pill">已锁定（防误改）</span></div>
          <p class="muted">预览和成品中已关闭插件市场修改，避免误装导致冲突。</p>
          ${capabilityRows}
        </div>
      </div>

      <div id="pane-settings" class="view-pane">
        <div class="card">
          <div class="card-hd"><h3>设置与模型凭据</h3><span class="pill ok">独立存储</span></div>
          <p class="muted">本客户端拥有独立的数据目录与模型配置，与官方 dsh 及其他客户端完全隔离。</p>
          <div class="item"><strong>工作区路径</strong><span class="tag">~/Workspaces/${slug}</span></div>
          <div class="item"><strong>系统身份</strong><span class="tag">${escapeHtml(spec.identity.appId)}</span></div>
        </div>
      </div>
    </main>
  </div>

  <script>
    const switchPane = (name) => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.getAttribute('data-nav') === name));
      document.querySelectorAll('.view-pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
    };
    document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => switchPane(b.getAttribute('data-nav'))));
    document.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => switchPane(b.getAttribute('data-jump'))));
    document.getElementById('toggle-theme')?.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      document.documentElement.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('run-bid-sample')?.addEventListener('click', async () => {
      const out = document.getElementById('sample-out');
      out.style.display = 'block';
      out.textContent = '正在解析招标 DOCX 并导出响应表…';
      const res = await fetch('/api/run-bid-sample', { method: 'POST' });
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
    });
    const stage = document.getElementById('canvas-stage');
    if (stage) {
      let count = 2;
      stage.addEventListener('click', (ev) => {
        const rect = stage.getBoundingClientRect();
        const x = ((ev.clientX - rect.left) / rect.width);
        const y = ((ev.clientY - rect.top) / rect.height);
        count += 1;
        const pin = document.createElement('div');
        pin.className = 'pin';
        pin.style.left = (x * 100).toFixed(1) + '%';
        pin.style.top = (y * 100).toFixed(1) + '%';
        pin.textContent = String(count);
        stage.appendChild(pin);
        const list = document.getElementById('ann-list');
        if (list) {
          const row = document.createElement('div');
          row.className = 'item';
          row.innerHTML = '<strong>#' + count + '</strong><span>位置 (' + (x * 100).toFixed(0) + '%, ' + (y * 100).toFixed(0) + '%)</span>';
          list.appendChild(row);
        }
      });
    }
    const es = new EventSource('/api/events');
    es.addEventListener('spec-updated', () => { window.location.reload(); });
  </script>
</body>
</html>`
}

async function main(): Promise<void> {
  const config = readConfig()
  mkdirSync(config.previewDir, { recursive: true })
  let revisionNonce = 1
  const loadSpec = (): ProductSpec => ProductSpecSchema.parse(JSON.parse(readFileSync(config.specPath, 'utf8')))
  let currentSpec = loadSpec()
  const sseClients = new Set<http.ServerResponse>()

  const notifyReload = (): void => {
    try {
      currentSpec = loadSpec()
      revisionNonce += 1
      for (const client of sseClients) {
        client.write(`event: spec-updated\ndata: ${JSON.stringify({ revision: currentSpec.revision, nonce: revisionNonce })}\n\n`)
      }
    } catch { /* ignore transient write */ }
  }

  process.on('message', (msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'reload-spec') {
      notifyReload()
    } else if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'shutdown') {
      server.close(() => process.exit(0))
    }
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, revision: currentSpec.revision, pid: process.pid }))
      return
    }
    if (url.pathname === '/api/product-spec') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(currentSpec))
      return
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(':\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (url.pathname === '/api/run-bid-sample' && req.method === 'POST') {
      try {
        const sample = createSampleBidDocx()
        const parsed = parseAndSanitizeDocx(sample)
        const analysis = analyzeBidDocument(parsed, {
          projectId: currentSpec.identity.productId,
          fileName: `${currentSpec.brand.displayName.zh}-sample.docx`,
        })
        const outBytes = buildBidResponseDocx(analysis)
        const verified = verifyExportedDocx(outBytes, ['2026-12-18', 'ISO 27001'])
        const outFile = path.join(config.previewDir, 'sample-response.docx')
        writeFileSync(outFile, outBytes)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          deadlines: analysis.deadlines.length,
          scoringItems: analysis.scoringItems.length,
          missingMaterials: analysis.missingMaterials.length,
          exportedBytes: outBytes.length,
          verifiedDocumentXmlBytes: verified.documentXmlBytes,
          outputPath: outFile,
        }))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
      return
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
      })
      res.end(renderPreviewHtml(currentSpec, revisionNonce))
      return
    }
    res.writeHead(404)
    res.end('Not Found')
  })

  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        const addr = server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    })

  let boundPort: number
  try {
    boundPort = await tryListen(config.preferredPort ?? 0)
  } catch {
    boundPort = await tryListen(0)
  }

  const readyPayload = {
    type: 'preview-ready',
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    pid: process.pid,
    revision: currentSpec.revision,
  }
  if (typeof process.send === 'function') {
    process.send(readyPayload)
  } else {
    process.stdout.write(`${JSON.stringify(readyPayload)}\n`)
  }
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
