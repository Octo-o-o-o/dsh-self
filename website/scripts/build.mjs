import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'src');
const output = path.join(root, 'dist');

if (path.resolve(output) !== path.join(path.resolve(root), 'dist')) {
  throw new Error('Unsafe output path');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

// Compute deterministic 8-char content hashes for first-party CSS/JS so HTML references are cache-busted
// and Worker can serve ?v=<hash> with Cache-Control: public, max-age=31536000, immutable.
const versionedAssets = ['/styles.css', '/guide.css', '/appearance.js', '/site.js'];
const assetHashes = new Map();
for (const webPath of versionedAssets) {
  const buf = await readFile(path.join(output, webPath.slice(1)));
  assetHashes.set(webPath, createHash('sha256').update(buf).digest('hex').slice(0, 8));
}

const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else files.push(absolute);
  }
}
await collect(output);

for (const file of files.filter((name) => name.endsWith('.html'))) {
  let html = await readFile(file, 'utf8');
  for (const [webPath, hash] of assetHashes.entries()) {
    html = html
      .replaceAll(`href="${webPath}"`, `href="${webPath}?v=${hash}"`)
      .replaceAll(`src="${webPath}"`, `src="${webPath}?v=${hash}"`);
  }
  await writeFile(file, html, 'utf8');
}

const errors = [];
for (const file of files.filter((name) => name.endsWith('.html'))) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const reference = match[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue;
    const pathname = decodeURIComponent(reference.split('#')[0].split('?')[0]);
    if (!pathname) continue;
    let target = pathname.startsWith('/')
      ? path.join(output, pathname.slice(1))
      : path.resolve(path.dirname(file), pathname);
    if (pathname.endsWith('/')) {
      target = path.join(target, 'index.html');
    } else if (!path.extname(target)) {
      target = `${target}.html`;
    }
    if (!target.startsWith(output)) {
      errors.push(`${path.relative(output, file)}: path leaves output: ${reference}`);
      continue;
    }
    try {
      const st = await stat(target);
      if (!st.isFile()) errors.push(`${path.relative(output, file)}: not a file: ${reference}`);
    } catch {
      errors.push(`${path.relative(output, file)}: missing ${reference}`);
    }
  }
}

// Validate /dsh/index.json JSON syntax and icon reference
const indexFile = path.join(output, 'dsh', 'index.json');
try {
  const indexData = JSON.parse(await readFile(indexFile, 'utf8'));
  if (indexData.format !== 1 || !Array.isArray(indexData.plugins)) {
    errors.push('dsh/index.json: invalid format or plugins array');
  } else {
    for (const plugin of indexData.plugins) {
      if (typeof plugin.icon === 'string' && !plugin.icon.startsWith('data:') && !/^https?:\/\//.test(plugin.icon)) {
        const iconPath = path.resolve(path.dirname(indexFile), plugin.icon);
        try {
          const st = await stat(iconPath);
          if (!st.isFile()) errors.push(`dsh/index.json: icon is not a file: ${plugin.icon}`);
        } catch {
          errors.push(`dsh/index.json: missing icon ${plugin.icon}`);
        }
      }
    }
  }
} catch (err) {
  errors.push(`dsh/index.json: ${err instanceof Error ? err.message : String(err)}`);
}

if (errors.length > 0) {
  throw new Error(`Static build verification failed:\n${errors.join('\n')}`);
}

console.log(`Built ${files.length} files to ${path.relative(root, output)}/`);
