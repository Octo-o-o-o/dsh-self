const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
};

const STATIC_CACHE_PATHS = new Set([
  '/styles.css',
  '/guide.css',
  '/appearance.js',
  '/site.js',
  '/site.webmanifest',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(key)) {
        headers.set(key, value);
      }
    }

    if (url.pathname === '/dsh/index.json') {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    } else if (url.pathname.startsWith('/dsh/icons/') || url.pathname.startsWith('/assets/')) {
      headers.set('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    } else if (STATIC_CACHE_PATHS.has(url.pathname)) {
      headers.set(
        'Cache-Control',
        url.searchParams.has('v')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=86400, stale-while-revalidate=86400',
      );
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    } else {
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    }

    if (url.pathname === '/site.webmanifest') {
      headers.set('Content-Type', 'application/manifest+json; charset=utf-8');
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
};
