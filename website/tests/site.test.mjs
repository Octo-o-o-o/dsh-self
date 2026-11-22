import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker.mjs';
import {
  CANONICAL_ORIGIN,
  DSH_TARGET,
  MARKET_INDEX_URL,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  VERIFICATION_SCOPE,
} from '../src/site.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');

function extractSectionIds(html) {
  return [...html.matchAll(/<section[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
}

test('bilingual homepages and guides keep identical section IDs and strict CSP hygiene', async () => {
  const zhHome = await readFile(path.join(dist, 'index.html'), 'utf8');
  const enHome = await readFile(path.join(dist, 'en', 'index.html'), 'utf8');
  const zhGuide = await readFile(path.join(dist, 'guide.html'), 'utf8');
  const enGuide = await readFile(path.join(dist, 'en', 'guide.html'), 'utf8');

  assert.deepEqual(extractSectionIds(zhHome), extractSectionIds(enHome));
  assert.deepEqual(extractSectionIds(zhGuide), extractSectionIds(enGuide));

  for (const [label, html] of [
    ['index.html', zhHome],
    ['en/index.html', enHome],
    ['guide.html', zhGuide],
    ['en/guide.html', enGuide],
  ]) {
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${label} must not contain inline event handlers`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${label} must not contain inline style attributes (strict CSP)`);
    assert.ok(html.includes(CANONICAL_ORIGIN), `${label} missing canonical origin`);
    assert.ok(html.includes(DSH_TARGET), `${label} missing pinned DSH target ${DSH_TARGET}`);
    assert.ok(html.includes(PLUGIN_NAME), `${label} missing plugin name ${PLUGIN_NAME}`);
  }
});

test('both homepages truthfully disclose unsigned-local-test status and verification scope', async () => {
  assert.match(VERIFICATION_SCOPE.commercialSigning, /unsigned-local-test/);
  assert.match(VERIFICATION_SCOPE.dshPluginRelease, /10 automated gates/);

  for (const rel of ['index.html', 'en/index.html']) {
    const html = await readFile(path.join(dist, rel), 'utf8');
    assert.ok(html.includes('unsigned-local-test'), `${rel} must disclose unsigned-local-test status`);
    assert.ok(html.includes('32 / 32'), `${rel} must report verified test count`);
    assert.ok(html.includes(MARKET_INDEX_URL), `${rel} must link to custom plugin index URL`);
    assert.ok(html.includes('prepare-plugin-release.mjs'), `${rel} must reference release packer`);
    if (rel.startsWith('en/')) {
      assert.match(html, /Pack once/i);
      assert.match(html, /Pinned.*dsh.*plugin/i);
      assert.match(html, /Distribute/i);
    } else {
      assert.match(html, /一次打包/);
      assert.match(html, /版本双固定/);
      assert.match(html, /分发给/);
    }
  }
});

test('custom DSH plugin index conforms to official format:1 contract', async () => {
  const raw = JSON.parse(await readFile(path.join(dist, 'dsh', 'index.json'), 'utf8'));
  assert.equal(raw.format, 1);
  assert.equal(typeof raw.title.en, 'string');
  assert.equal(typeof raw.title.zh, 'string');
  assert.equal(raw.plugins.length, 1);

  const plugin = raw.plugins[0];
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.equal(plugin.homepage, `${CANONICAL_ORIGIN}/`);
  assert.equal(plugin.versions[0].version, PLUGIN_VERSION);
  assert.equal(plugin.versions[0].engines.dsh, '>=0.2.2-rc.1 <0.3.0');
  assert.equal(plugin.versions[0].source.type, 'npm');

  const iconPath = path.join(dist, 'dsh', plugin.icon);
  const iconStat = await stat(iconPath);
  assert.ok(iconStat.isFile(), 'plugin index icon must exist');
  assert.ok(iconStat.size <= 32 * 1024, 'plugin index icon must be <= 32 KiB');
});

test('worker attaches strict security, HSTS, COOP/CORP, caching and JSON CORS headers', async () => {
  const htmlRes = await worker.fetch(new Request(`${CANONICAL_ORIGIN}/`), {
    ASSETS: {
      fetch: async () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    },
  });
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(htmlRes.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(htmlRes.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.match(htmlRes.headers.get('Strict-Transport-Security') || '', /max-age=31536000/);
  assert.match(htmlRes.headers.get('Content-Security-Policy') || '', /default-src 'self'/);

  const cssRes = await worker.fetch(new Request(`${CANONICAL_ORIGIN}/styles.css?v=12345678`), {
    ASSETS: {
      fetch: async () => new Response('body{}', { status: 200, headers: { 'Content-Type': 'text/css' } }),
    },
  });
  assert.match(cssRes.headers.get('Cache-Control') || '', /max-age=31536000, immutable/);

  const idxRes = await worker.fetch(new Request(MARKET_INDEX_URL), {
    ASSETS: {
      fetch: async () => new Response('{"format":1}', { status: 200 }),
    },
  });
  assert.equal(idxRes.status, 200);
  assert.equal(idxRes.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(idxRes.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(idxRes.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
});

test('all pages include GitHub and OctoLab links in header & footer plus complete SEO/JSON-LD & manifest', async () => {
  const manifest = JSON.parse(await readFile(path.join(dist, 'site.webmanifest'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const st = await stat(path.join(dist, icon.src.replace(/^\//, '')));
    assert.ok(st.isFile(), `manifest icon missing: ${icon.src}`);
  }
  const ogPng = await stat(path.join(dist, 'assets', 'og-card.png'));
  assert.ok(ogPng.isFile() && ogPng.size > 1000, 'og-card.png must exist');

  for (const rel of ['index.html', 'guide.html', 'en/index.html', 'en/guide.html']) {
    const html = await readFile(path.join(dist, rel), 'utf8');
    const headerMatch = html.match(/<header[\s\S]*?<\/header>/);
    const footerMatch = html.match(/<footer[\s\S]*?<\/footer>/);
    assert.ok(headerMatch && footerMatch, `${rel} missing header/footer`);
    assert.ok(headerMatch[0].includes('https://github.com/Octo-o-o-o/dsh-self'), `${rel} header missing GitHub link`);
    assert.ok(headerMatch[0].includes('https://octoooo.com'), `${rel} header missing OctoLab link`);
    assert.ok(footerMatch[0].includes('https://github.com/Octo-o-o-o/dsh-self'), `${rel} footer missing GitHub link`);
    assert.ok(footerMatch[0].includes('https://octoooo.com'), `${rel} footer missing OctoLab link`);
    assert.ok(html.includes('og-card.png'), `${rel} missing PNG og:image`);
    assert.ok(html.includes('site.webmanifest'), `${rel} missing webmanifest link`);
    assert.ok(html.includes('apple-touch-icon.png'), `${rel} missing apple-touch-icon`);
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ldMatch, `${rel} missing JSON-LD structured data`);
    const ld = JSON.parse(ldMatch[1]);
    assert.equal(ld['@context'], 'https://schema.org');
  }
});

test('all bilingual pages enforce PolyForm Noncommercial + <= 20 internal users free + Commercial dual-licensing with zero stale MIT claims', async () => {
  for (const rel of ['index.html', 'guide.html', 'en/index.html', 'en/guide.html']) {
    const html = await readFile(path.join(dist, rel), 'utf8');
    assert.equal(html.includes('MIT 开源'), false, `stale MIT claim in ${rel}`);
    assert.equal(html.includes('MIT License'), false, `stale MIT License in ${rel}`);
    assert.equal(html.includes('MIT Licensed'), false, `stale MIT Licensed in ${rel}`);
    assert.ok(html.includes('PolyForm Noncommercial'), `missing PolyForm Noncommercial in ${rel}`);
    assert.ok(html.includes('20'), `missing <= 20 internal users threshold in ${rel}`);
    assert.ok(html.includes('octoooo@octoooo.com'), `missing commercial license email in ${rel}`);
    assert.ok(html.includes('COMMERCIAL-LICENSE.md'), `missing COMMERCIAL-LICENSE.md reference in ${rel}`);
  }
});

test('sitemap.xml and robots.txt reference canonical dsh-self.octoooo.com', async () => {
  const robots = await readFile(path.join(dist, 'robots.txt'), 'utf8');
  const sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8');
  assert.ok(robots.includes(`${CANONICAL_ORIGIN}/sitemap.xml`));
  assert.ok(sitemap.includes(`${CANONICAL_ORIGIN}/`));
  assert.ok(sitemap.includes(`${CANONICAL_ORIGIN}/en/`));
  assert.ok(sitemap.includes(`${CANONICAL_ORIGIN}/guide`));
  assert.ok(sitemap.includes(`${CANONICAL_ORIGIN}/en/guide`));
});
