export const PLUGIN_NAME = 'dsh-self-studio';
export const PLUGIN_VERSION = '0.1.0';
export const DSH_TARGET = '0.2.2-rc.5';
export const CANONICAL_ORIGIN = 'https://dsh-self.octoooo.com';
export const REPOSITORY_URL = 'https://github.com/Octo-o-o-o/dsh-self';
export const MARKET_INDEX_URL = `${CANONICAL_ORIGIN}/dsh/index.json`;

export const VERIFICATION_SCOPE = Object.freeze({
  unitAndContractTests: '32 passed across 8 test files (product-spec, catalog, bid-docx, design-canvas, desktop-security, studio-and-ssrf, builder-and-stagers, upstream-contract)',
  dshPluginRelease: 'v0.1.0 release-prepared and verified via 10 automated gates + live install/RPC/worker smoke on official dsh@0.2.2-rc.1 Desktop and dsh@0.2.2-rc.5; local .tgz installable today, public npm/GitHub publish pending maintainer action',
  windowsNsis: 'Verified E2E on Windows 11 across 5 real NSIS installers (silent install, hardened Electron Fuses, cold launch /api/product-spec HTTP 200 with zero orphan Host, coexistence, same-name disambiguation, rename upgrade, dual-slot switch, packaged redacted diagnostics, downgrade block exit 1638, unilateral uninstall)',
  linuxAndMac: 'Linux .deb (/opt/<slug>) and macOS ASCII .app + inside-out codesign stagers unit-tested; cross-platform portable bundle, GitHub Actions & Docker/remote recipes generated; native host installation acceptance staged separately',
  commercialSigning: 'Local builds are explicitly tagged unsigned-local-test; commercial code signing & macOS notarization are separate release stages',
});

const BLUEPRINTS = {
  bids: {
    zh: {
      name: '青禾投标',
      badge: 'list-detail · 列表+详情',
      slug: 'qinghe-bids-11111111',
      version: 'v0.1.0',
      monogram: '标',
      readiness: '本地解析与导出立即可用；如需 AI 起草响应，可在左侧设置填写模型密钥。',
      workspace: '~/Workspaces/qinghe-bids-11111111',
      nav: ['工作台首页', '标书解析', '已装插件 (2)', '模型与设置'],
      cards: [
        {
          title: '截止日期追踪',
          tag: 'deadlines',
          body: '华东政务云二期项目 · 2026-12-18 14:00 · 距开标 26 天',
          foot: '支持纯本地 .ics 截止提醒',
        },
        {
          title: '缺失资质与材料',
          tag: 'missing-materials',
          body: '待补齐：ISO 27001 信息安全认证、近三年审计报告（已定位第 14 页评分表）',
          foot: '扫描件 / 加密件自动拦截',
        },
        {
          title: '招标原文定位与导出',
          tag: 'bid-preview',
          body: 'Opaque-origin 沙箱预览（零外部请求、禁 w:altChunk），双向高亮跳转原文并一键导出逐条响应表 .docx',
          foot: 'ZIP 炸弹 / XXE / UNC 剥离',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 3,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "11111111-1111-4111-8111-111111111111",
    "internalSlug": "qinghe-bids-11111111",
    "appId": "app.dshself.u11111111",
    "nsisGuid": "11111111-1111-4111-8111-111111111111"
  },
  "brand": { "displayName": { "zh": "青禾投标", "en": "Qinghe Bids" } },
  "home": {
    "layout": "list-detail",
    "sections": ["deadlines", "missing-materials", "bid-preview"],
    "primaryAction": "bid.importRequirements"
  },
  "requiredActions": ["bid.importRequirements", "bid.exportResponseDocx"]
}`,
    },
    en: {
      name: 'Qinghe Bids',
      badge: 'list-detail layout',
      slug: 'qinghe-bids-11111111',
      version: 'v0.1.0',
      monogram: 'B',
      readiness: 'Local DOCX parsing and export work offline immediately; add model keys in Settings for AI drafting.',
      workspace: '~/Workspaces/qinghe-bids-11111111',
      nav: ['Home Workbench', 'Bid Workspace', 'Plugins (2)', 'Models & Settings'],
      cards: [
        {
          title: 'Deadlines',
          tag: 'deadlines',
          body: 'East Cloud Phase II RFP · 2026-12-18 14:00 · 26 days left',
          foot: 'Pure-local .ics deadline export',
        },
        {
          title: 'Missing Materials',
          tag: 'missing-materials',
          body: 'Pending: ISO 27001 cert, 3-year audit report (anchored to p.14 rubric)',
          foot: 'Blocks scanned & encrypted files',
        },
        {
          title: 'Bid Source Preview & Export',
          tag: 'bid-preview',
          body: 'Sandboxed opaque-origin iframe preview with strict CSP, two-way bookmark jump & one-click response .docx export.',
          foot: 'Strips ZIP bombs, XXE & UNC paths',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 3,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "11111111-1111-4111-8111-111111111111",
    "internalSlug": "qinghe-bids-11111111",
    "appId": "app.dshself.u11111111",
    "nsisGuid": "11111111-1111-4111-8111-111111111111"
  },
  "brand": { "displayName": { "zh": "青禾投标", "en": "Qinghe Bids" } },
  "home": {
    "layout": "list-detail",
    "sections": ["deadlines", "missing-materials", "bid-preview"],
    "primaryAction": "bid.importRequirements"
  },
  "requiredActions": ["bid.importRequirements", "bid.exportResponseDocx"]
}`,
    },
  },
  design: {
    zh: {
      name: '青禾设计室',
      badge: 'three-pane · 三栏工作台',
      slug: 'qinghe-design-22222222',
      version: 'v0.1.0',
      monogram: '设',
      readiness: '三栏位图画布与超长图高清 PNG 导出纯本地可用；可选共存 AI 原型画框面板。',
      workspace: '~/Workspaces/qinghe-design-22222222',
      nav: ['三栏画布台', 'AI 原型画框', '已装插件 (2)', '模型与设置'],
      cards: [
        {
          title: '项目列表',
          tag: 'project-list',
          body: '新品详情页长图 (2000×40000) · 竖版海报 EXIF-6 · 官网首页终稿',
          foot: '多稿件独立 .annotations.json',
        },
        {
          title: '作品画布',
          tag: 'design-canvas',
          body: '限边 <= 4096px 预览代理规避 GPU 纹理上限，自动归一化 EXIF 旋转与 sRGB 色彩',
          foot: '归一化 [0, 1] 坐标不漂移',
        },
        {
          title: '属性与批注',
          tag: 'annotations-panel',
          body: '#1 主标题对比度提升至 7:1 · #2 价格区右对齐主栅格 · 逐标注几何徽标离屏合成 PNG',
          foot: '绕过 Cairo 32,767px 硬上限',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 2,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "22222222-2222-4222-8222-222222222222",
    "internalSlug": "qinghe-design-22222222",
    "appId": "app.dshself.u22222222",
    "nsisGuid": "22222222-2222-4222-8222-222222222222"
  },
  "brand": { "displayName": { "zh": "青禾设计室", "en": "Qinghe Design" } },
  "home": {
    "layout": "three-pane",
    "sections": ["project-list", "design-canvas", "annotations-panel"],
    "primaryAction": "design.importImage"
  },
  "requiredActions": ["design.importImage", "design.saveAnnotations", "design.exportAnnotatedPng"]
}`,
    },
    en: {
      name: 'Qinghe Design',
      badge: 'three-pane layout',
      slug: 'qinghe-design-22222222',
      version: 'v0.1.0',
      monogram: 'D',
      readiness: 'Three-pane bitmap canvas and tiled ultra-long PNG export run locally; AI prototype studio coexists optionally.',
      workspace: '~/Workspaces/qinghe-design-22222222',
      nav: ['Design Workbench', 'Prototype Studio', 'Plugins (2)', 'Models & Settings'],
      cards: [
        {
          title: 'Projects',
          tag: 'project-list',
          body: 'Campaign Scroll (2000×40000) · Poster EXIF-6 · Landing Hero v4',
          foot: 'Per-project .annotations.json',
        },
        {
          title: 'Design Canvas',
          tag: 'design-canvas',
          body: 'Bounded <= 4096 px preview proxy avoids GPU texture caps; auto-orients EXIF & converts ICC to sRGB.',
          foot: 'Normalized [0, 1] coordinates',
        },
        {
          title: 'Properties & Annotations',
          tag: 'annotations-panel',
          body: '#1 Boost hero contrast to 7:1 · #2 Align pricing grid · Tiled geometric SVG badges via sharp.composite.',
          foot: 'Bypasses Cairo 32,767 px limit',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 2,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "22222222-2222-4222-8222-222222222222",
    "internalSlug": "qinghe-design-22222222",
    "appId": "app.dshself.u22222222",
    "nsisGuid": "22222222-2222-4222-8222-222222222222"
  },
  "brand": { "displayName": { "zh": "青禾设计室", "en": "Qinghe Design" } },
  "home": {
    "layout": "three-pane",
    "sections": ["project-list", "design-canvas", "annotations-panel"],
    "primaryAction": "design.importImage"
  },
  "requiredActions": ["design.importImage", "design.saveAnnotations", "design.exportAnnotatedPng"]
}`,
    },
  },
  legal: {
    zh: {
      name: '法务合同助手',
      badge: 'dashboard-grid · 卡片看板',
      slug: 'legal-desk-44444444',
      version: 'v0.1.0',
      monogram: '法',
      readiness: '默认关闭会话日志与联网检索（纯本地模式），敏感合同文件绝不离开本机工作区。',
      workspace: '~/Workspaces/legal-desk-44444444',
      nav: ['审查看板', '随手记', '已装插件 (2)', '模型与设置'],
      cards: [
        {
          title: '项目列表',
          tag: 'project-list',
          body: '年度框架采购协议 · 数据合规补充条款 · 渠道代理 NDA',
          foot: '独立工作区与双槽配置',
        },
        {
          title: '截止日期追踪',
          tag: 'deadlines',
          body: '供应商续签审阅截止 11-29 · 保密协议归档提醒 12-03',
          foot: '不依赖外部云日历',
        },
        {
          title: '继续工作',
          tag: 'recent-sessions',
          body: '上次未完成：违约责任上限批注与逐条修订清单导出',
          foot: '重启后自动恢复上下文',
        },
        {
          title: '外部连接状态',
          tag: 'connections-card',
          body: '遥测已关闭 · tool-web 已禁用 · 诊断导出自动剔除凭据与 .env',
          foot: '最小环境变量白名单',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 1,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "44444444-4444-4444-8444-444444444444",
    "internalSlug": "legal-desk-44444444",
    "appId": "app.dshself.u44444444",
    "nsisGuid": "44444444-4444-4444-8444-444444444444"
  },
  "brand": { "displayName": { "zh": "法务合同助手", "en": "Contract Desk" } },
  "shell": { "defaultPanel": "home", "localOnlyToolWebDisabled": true },
  "home": {
    "layout": "dashboard-grid",
    "sections": ["project-list", "deadlines", "recent-sessions", "connections-card"],
    "primaryAction": "bid.importRequirements"
  }
}`,
    },
    en: {
      name: 'Contract Desk',
      badge: 'dashboard-grid layout',
      slug: 'legal-desk-44444444',
      version: 'v0.1.0',
      monogram: 'L',
      readiness: 'Telemetry and web tools are disabled by default (local-first mode); contracts stay strictly in this isolated workspace.',
      workspace: '~/Workspaces/legal-desk-44444444',
      nav: ['Review Board', 'Scratchpad', 'Plugins (2)', 'Models & Settings'],
      cards: [
        {
          title: 'Projects',
          tag: 'project-list',
          body: 'Master Procurement MSA · Data DPA Addendum · Partner NDA',
          foot: 'Isolated workspace & dual slots',
        },
        {
          title: 'Deadlines',
          tag: 'deadlines',
          body: 'Vendor renewal cutoff Nov 29 · NDA archive check Dec 03',
          foot: 'No external cloud account needed',
        },
        {
          title: 'Continue Working',
          tag: 'recent-sessions',
          body: 'Resume: liability cap review & clause-by-clause response export',
          foot: 'Restores state across restarts',
        },
        {
          title: 'Connections',
          tag: 'connections-card',
          body: 'Telemetry off · tool-web disabled · Redacted diagnostics strip secrets & .env',
          foot: 'Minimal env whitelist',
        },
      ],
      spec: `{
  "schemaVersion": 1,
  "revision": 1,
  "appVersion": "0.1.0",
  "identity": {
    "productId": "44444444-4444-4444-8444-444444444444",
    "internalSlug": "legal-desk-44444444",
    "appId": "app.dshself.u44444444",
    "nsisGuid": "44444444-4444-4444-8444-444444444444"
  },
  "brand": { "displayName": { "zh": "法务合同助手", "en": "Contract Desk" } },
  "shell": { "defaultPanel": "home", "localOnlyToolWebDisabled": true },
  "home": {
    "layout": "dashboard-grid",
    "sections": ["project-list", "deadlines", "recent-sessions", "connections-card"],
    "primaryAction": "bid.importRequirements"
  }
}`,
    },
  },
};

function applyThemePreference(preference) {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  root.dataset.appearance = preference;
  root.dataset.theme = resolved;
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', resolved === 'dark' ? '#0b1215' : '#f4f7f6');
  }
  try {
    localStorage.setItem('dsh-self-theme', preference);
  } catch {
    /* ignore */
  }
  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    const active = btn.getAttribute('data-theme-choice') === preference;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.classList.toggle('is-active', active);
  });
}

function initThemeSwitcher() {
  const current = document.documentElement.dataset.appearance || 'system';
  applyThemePreference(current);

  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-theme-choice') || 'system';
      applyThemePreference(choice);
    });
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (document.documentElement.dataset.appearance === 'system') {
      applyThemePreference('system');
    }
  };
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
  }
}

function initLanguageLinks() {
  document.querySelectorAll('[data-lang-switch]').forEach((link) => {
    link.addEventListener('click', () => {
      const targetLang = link.getAttribute('data-lang-switch');
      try {
        if (targetLang) sessionStorage.setItem('dsh-self-lang-choice', targetLang);
      } catch {
        /* ignore */
      }
      const rawHref = link.getAttribute('href') || '';
      const [base, existingQuery = ''] = rawHref.split('#')[0].split('?');
      if (base) {
        const merged = new URLSearchParams(location.search);
        const targetParams = new URLSearchParams(existingQuery);
        merged.delete('lang');
        for (const [k, v] of targetParams.entries()) {
          merged.set(k, v);
        }
        const qs = merged.toString();
        link.setAttribute('href', `${base}${qs ? `?${qs}` : ''}${location.hash}`);
      }
    });
  });
}

function initCopyButtons() {
  const isEn = document.documentElement.lang.toLowerCase().startsWith('en');
  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-copy-target');
      const source = targetId ? document.getElementById(targetId) : null;
      const text = source?.textContent?.trim() || '';
      if (!text) return;
      const original = btn.dataset.originalLabel || btn.textContent || '';
      btn.dataset.originalLabel = original;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = isEn ? 'Copied' : '已复制';
        btn.classList.add('is-copied');
      } catch {
        btn.textContent = isEn ? 'Select manually' : '请手动复制';
      }
      window.setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('is-copied');
      }, 1800);
    });
  });
}

function initBlueprintShowcase() {
  const showcase = document.getElementById('blueprint-showcase');
  if (!showcase) return;
  const lang = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';

  let currentPreset = 'bids';
  let currentMode = 'ui';
  let currentFrameTheme = 'light';

  const render = () => {
    const data = BLUEPRINTS[currentPreset]?.[lang] || BLUEPRINTS.bids[lang];
    showcase.dataset.preset = currentPreset;
    showcase.dataset.frameTheme = currentFrameTheme;
    showcase.dataset.frameView = currentMode;

    const titleEl = showcase.querySelector('[data-bp-title]');
    const verEl = showcase.querySelector('[data-bp-version]');
    const badgeEl = showcase.querySelector('[data-bp-badge]');
    const monoEl = showcase.querySelector('[data-bp-monogram]');
    const readyEl = showcase.querySelector('[data-bp-readiness]');
    const wsEl = showcase.querySelector('[data-bp-workspace]');
    const navEl = showcase.querySelector('[data-bp-nav]');
    const gridEl = showcase.querySelector('[data-bp-cards]');
    const specEl = showcase.querySelector('[data-bp-spec]');
    const uiPane = showcase.querySelector('[data-bp-pane="ui"]');
    const specPane = showcase.querySelector('[data-bp-pane="spec"]');

    if (titleEl) titleEl.textContent = data.name;
    if (verEl) verEl.textContent = data.version;
    if (badgeEl) badgeEl.textContent = data.badge;
    if (monoEl) monoEl.textContent = data.monogram;
    if (readyEl) readyEl.textContent = data.readiness;
    if (wsEl) wsEl.textContent = data.workspace;
    if (specEl) specEl.textContent = data.spec;

    if (navEl) {
      navEl.textContent = '';
      data.nav.forEach((label, idx) => {
        const item = document.createElement('div');
        item.className = idx === 0 ? 'mock-nav-item is-active' : 'mock-nav-item';
        item.textContent = label;
        navEl.appendChild(item);
      });
    }

    if (gridEl) {
      gridEl.textContent = '';
      gridEl.dataset.layout = currentPreset;
      data.cards.forEach((card, idx) => {
        const el = document.createElement('article');
        el.className = 'mock-card';
        const head = document.createElement('div');
        head.className = 'mock-card-head';
        const strong = document.createElement('strong');
        strong.textContent = card.title;
        const tag = document.createElement('code');
        tag.textContent = `#${idx + 1} ${card.tag}`;
        head.append(strong, tag);
        const body = document.createElement('p');
        body.textContent = card.body;
        const foot = document.createElement('span');
        foot.className = 'mock-card-foot';
        foot.textContent = card.foot;
        el.append(head, body, foot);
        gridEl.appendChild(el);
      });
    }

    if (uiPane && specPane) {
      uiPane.hidden = currentMode !== 'ui';
      specPane.hidden = currentMode !== 'spec';
    }

    showcase.querySelectorAll('[data-bp-preset]').forEach((btn) => {
      const active = btn.getAttribute('data-bp-preset') === currentPreset;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
    showcase.querySelectorAll('[data-bp-view]').forEach((btn) => {
      const active = btn.getAttribute('data-bp-view') === currentMode;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    });
    const themeToggle = showcase.querySelector('[data-bp-frame-theme]');
    if (themeToggle) {
      themeToggle.setAttribute('aria-pressed', currentFrameTheme === 'dark' ? 'true' : 'false');
      themeToggle.textContent =
        currentFrameTheme === 'dark'
          ? (lang === 'en' ? 'Preview: Light' : '预览：切浅色')
          : (lang === 'en' ? 'Preview: Dark' : '预览：切深色');
    }
  };

  showcase.querySelectorAll('[data-bp-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-bp-preset');
      if (p && BLUEPRINTS[p]) {
        currentPreset = p;
        render();
      }
    });
  });

  showcase.querySelectorAll('[data-bp-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-bp-view');
      if (v === 'ui' || v === 'spec') {
        currentMode = v;
        render();
      }
    });
  });

  const themeToggle = showcase.querySelector('[data-bp-frame-theme]');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      currentFrameTheme = currentFrameTheme === 'light' ? 'dark' : 'light';
      render();
    });
  }

  render();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initThemeSwitcher();
    initLanguageLinks();
    initCopyButtons();
    initBlueprintShowcase();
  });
}
