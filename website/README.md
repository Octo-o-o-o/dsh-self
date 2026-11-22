# dsh-self Website (`dsh-self.octoooo.com`)

Bilingual (`zh-CN` / `en`) static product website deployed on Cloudflare Workers Static Assets (`dsh-self-site`), serving canonical domain `https://dsh-self.octoooo.com/` along with the official DSH Custom Plugin Index at `https://dsh-self.octoooo.com/dsh/index.json`.

## Pages

- Chinese: `/index.html`, `/guide.html`, `/404.html`
- English: `/en/index.html`, `/en/guide.html`, `/en/404.html`
- DSH Custom Plugin Index (`format: 1`): `/dsh/index.json` & `/dsh/icons/dsh-self-studio.svg`

## Build, Test & Preview

Zero third-party npm packages are required; build, static reference checks, and tests run natively on Node.js 20+:

```bash
cd website
npm test
npm run dev
```

`npm run dev` serves `dist/` at `http://127.0.0.1:4173` (override with `PORT`).

## Deploy to `dsh-self.octoooo.com`

```bash
cd website
npm test
npx wrangler deploy
```
