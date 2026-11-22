import { useEffect, useState, type ReactNode } from 'react'
import css from './business.module.css'
import type { ProductSpec } from '@dsh-self/product-spec'
import type { BidProjectAnalysis } from '@dsh-self/adapters/bid-docx'
import type { AnnotationsFile, AnnotationPoint } from '@dsh-self/adapters/design-canvas'
import { WIDGET_CATALOG, type ActionId, type WidgetId } from '@dsh-self/product-spec/catalog-contract'

interface Item { id: string; name: string }
interface BidDocument { analysis: BidProjectAnalysis; blocks?: { text: string }[] }
interface Artwork { annotationsFile: AnnotationsFile; proxy: string }
interface Output { base64: string; outputPath?: string }

async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/dsh-self/' + route, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || response.statusText)
  return result as T
}

function fileContents(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1]!)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function BusinessWorkspace({ kind, actions, home }: {
  kind: 'bid' | 'design'; actions: readonly ActionId[]; home: ProductSpec['home']
}) {
  const [items, setItems] = useState<Item[]>([])
  const [id, setId] = useState('')
  const [bid, setBid] = useState<BidDocument>()
  const [art, setArt] = useState<Artwork>()
  const [points, setPoints] = useState<AnnotationPoint[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [download, setDownload] = useState<{ url: string; name: string; path?: string }>()
  const isBid = kind === 'bid'
  const route = kind + '/projects'
  useEffect(() => {
    let active = true
    request<{ projects: Item[] }>(route).then(({ projects }) => {
      if (active) { setItems(projects); setId(projects[0]?.id ?? '') }
    }).catch(error => { if (active) setMessage(String(error)) })
    return () => { active = false }
  }, [route])
  useEffect(() => {
    let active = true
    setBid(undefined); setArt(undefined); setPoints([]); setDownload(undefined)
    if (id) {
      const url = route + '?id=' + encodeURIComponent(id)
      const load = isBid
        ? request<BidDocument>(url).then(result => { if (active) setBid(result) })
        : request<Artwork>(url).then(result => {
          if (active) { setArt(result); setPoints(result.annotationsFile.annotations) }
        })
      void load.catch(error => { if (active) setMessage(String(error)) })
    }
    return () => { active = false }
  }, [route, id, isBid])
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage(''); setDownload(undefined)
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function importFile(file: File) {
    const imported = await request<{ projectId: string }>(kind + '/import', {
      fileName: file.name, base64: await fileContents(file), summaryOnly: true,
    })
    const { projects } = await request<{ projects: Item[] }>(route)
    setItems(projects); setId(imported.projectId)
  }
  function offer(output: Output, name: string, mime: string) {
    setDownload({ url: `data:${mime};base64,${output.base64}`, name, path: output.outputPath })
    if (output.outputPath) setMessage('已保存到工作区 / Saved to workspace')
  }
  async function savePoints() {
    const saved = await request<AnnotationsFile>('design/annotations', { projectId: id, annotations: points })
    setPoints(saved.annotations)
    setMessage('已保存批注 / Annotations saved')
  }
  const primary: WidgetId = isBid ? 'bid-preview' : 'design-canvas'
  const fallback = home.sections.includes(primary) ? primary : home.sections[0]!
  const panels = new Map<WidgetId, ReactNode[]>()
  function place(preferred: WidgetId, content: ReactNode) {
    const target = home.sections.includes(preferred) ? preferred : fallback
    panels.set(target, [...(panels.get(target) ?? []), content])
  }
  place(isBid ? primary : 'project-list', <div key="files" className={css.stack}>
    <label>{isBid ? '导入标书 / Import DOCX' : '导入作品 / Import image'}{' '}
      <input type="file" accept={isBid ? '.docx' : 'image/png,image/jpeg,image/webp'} disabled={busy}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void run(() => importFile(file))
        }} />
    </label>
    {items.length > 0 && <label>已存文件 / Saved files{' '}
      <select value={id} disabled={busy} onChange={event => { setId(event.target.value); setMessage('') }}>
        {items.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}</option>)}
      </select>
    </label>}
  </div>)
  if (isBid) {
    place('deadlines', bid?.analysis.deadlines.length ? <ul key="dates" aria-label="截止日期 / Bid analysis">
        {bid.analysis.deadlines.map(d => <li key={d.id}>{d.summary}{' '}
          {actions.includes('calendar.addDeadline') && <button disabled={busy} onClick={() => void run(async () =>
            offer(await request<Output>('bid/calendar', { projectId: id, deadlineId: d.id }), d.id + '.ics', 'text/calendar'))}>
            导出日历提醒 / Calendar</button>}</li>)}
    </ul> : <p key="dates">{bid ? '该文件未识别出截止日 / No deadline found' : '导入标书后查看截止时间 / Import a bid to see deadlines'}</p>)
    place('missing-materials', bid?.analysis.missingMaterials.length ? <ul key="materials">
        {bid.analysis.missingMaterials.map(m => <li key={m.id}>{m.requirement}</li>)}
    </ul> : <p key="materials">{bid ? '该文件未识别出资质要求 / No qualifications found' : '导入标书后查看所需材料 / Import a bid to see requirements'}</p>)
    if (bid) place(primary, <div key="response" className={css.stack}><ul aria-label="评分项 / Scoring">
        {bid.analysis.scoringItems.map(s => <li key={s.id}>{s.title}</li>)}
      </ul>
      {bid.blocks && <details><summary>原文 / Source text</summary>{bid.blocks.map((block, i) => <p key={i}>{block.text}</p>)}</details>}
      {actions.includes('bid.exportResponseDocx') && <button disabled={busy} onClick={() => void run(async () =>
        offer(await request<Output>('bid/export', { projectId: id }), 'response.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))}>导出响应表 / Export DOCX</button>}
    </div>)
  } else if (art) {
    place(primary, <div key="art" className={css.stack}>
      <div style={{ position: 'relative', width: 'fit-content', maxWidth: '100%' }}>
        <img src={`data:image/png;base64,${art.proxy}`} alt={art.annotationsFile.originalFileName}
          style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', cursor: 'crosshair' }}
          onClick={e => {
            if (busy || !actions.includes('design.saveAnnotations')) return
            const box = e.currentTarget.getBoundingClientRect()
            const x = (e.clientX - box.left) / box.width
            const y = (e.clientY - box.top) / box.height
            setPoints(previous => [...previous, { id: crypto.randomUUID(), index: previous.length + 1, x, y, note, color: '#dc2626' }])
            setNote(''); setDownload(undefined); setMessage('有待保存的批注 / Unsaved annotations')
          }} />
        {points.map(p => <span key={p.id} aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none',
          left: (100 * p.x) + '%', top: (100 * p.y) + '%', color: 'white', background: p.color, padding: '0 4px', borderRadius: 8 }}>{p.index}</span>)}
      </div>
    </div>)
    place('annotations-panel', <div key="annotations" className={css.stack}>
      <label>批注 / Note <input value={note} maxLength={1000} disabled={busy} onChange={e => setNote(e.target.value)} /></label>
      {points.length === 0 && <p>填写批注后点击作品上的位置 / Type a note and click the artwork</p>}
      <ol>{points.map(p => <li key={p.id}>{p.note || '批注 / Note'}</li>)}</ol>
      {actions.includes('design.saveAnnotations') && <button disabled={busy} onClick={() => void run(savePoints)}>保存批注 / Save notes</button>}
      {actions.includes('design.exportAnnotatedPng') && <button disabled={busy} onClick={() => void run(async () =>
        offer(await request<Output>('design/export', { projectId: id, annotations: points }), 'annotated.png', 'image/png'))}>
        导出批注图 / Export PNG</button>}
    </div>)
  } else {
    place(primary, <p key="canvas">导入图片以开始审阅 / Import artwork to begin</p>)
    place('annotations-panel', <p key="notes">选中作品后可添加批注 / Select artwork to add notes</p>)
  }
  if (home.sections.includes('recent-sessions')) place('recent-sessions',
    <div key="resume" className={css.stack}>{items.length ? items.map(item =>
      <button key={item.id} disabled={busy} onClick={() => { setId(item.id); setMessage('') }}>{item.name} · {item.id.slice(0, 8)}</button>)
      : <p>导入后可从这里继续处理文件 / Imported files appear here</p>}</div>)
  if (home.sections.includes('connections-card')) place('connections-card', <p key="connections">
    {isBid ? 'DOCX 解析与导出在本地运行 / DOCX runs locally' : '图片与批注在本地处理 / Artwork runs locally'}</p>)
  if (message || download) place(isBid ? primary : 'annotations-panel', <div key="result" className={css.result}>
    {message && <span role="status" title={download?.path} data-saved-path={download?.path}>{message}</span>}
    {download && <a download={download.name} href={download.url}>下载 / Download {download.name}</a>}
    {download?.path && <details><summary>文件位置 / File location</summary><code>{download.path}</code></details>}
  </div>)
  return <div className={css.viewport}><div className={css.board} data-layout={home.layout}>
    {home.sections.filter(section => panels.has(section)).map(section => <section className={css.panel} data-section={section} key={section}>
      <h3>{home.sectionLabels?.[section] ?? (section === 'recent-sessions' ? '继续处理文件 / Resume work' : WIDGET_CATALOG[section].title.zh)}</h3>
      {panels.get(section)}
    </section>)}
  </div></div>
}
