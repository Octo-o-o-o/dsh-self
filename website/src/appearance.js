(() => {
  const root = document.documentElement;
  root.dataset.enhanced = 'true';

  let language = 'zh-CN';
  try {
    const preferred = navigator.languages?.[0] || navigator.language;
    if (typeof preferred === 'string' && preferred.trim()) {
      const tag = preferred.trim();
      if (/^(zh|zho|chi|cmn|yue)([-_]|$)/i.test(tag)) {
        language = 'zh-CN';
      } else if (
        !/^(c|posix|und|unknown)$/i.test(tag) &&
        /^[a-z]{2,3}([-_][a-z0-9]{1,8})*$/i.test(tag)
      ) {
        language = 'en';
      }
    }
  } catch {
    /* Keep Chinese if language detection is unavailable. */
  }

  root.dataset.systemLanguage = language;

  // Neutral root paths route non-Chinese browsers to English once; explicit ?lang=zh never bounces.
  const neutralTargets = {
    '/': '/en/',
    '/guide': '/en/guide',
  };
  const params = new URLSearchParams(location.search);
  if (params.get('lang') === 'zh') {
    try {
      sessionStorage.setItem('dsh-self-lang-choice', 'zh');
    } catch {
      /* ignore */
    }
  } else {
    const target = neutralTargets[location.pathname];
    if (target && language === 'en') {
      let explicitLang = null;
      try {
        explicitLang = sessionStorage.getItem('dsh-self-lang-choice');
      } catch {
        /* ignore */
      }
      if (explicitLang !== 'zh') {
        location.replace(`${target}${location.search}${location.hash}`);
      }
    }
  }

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem('dsh-self-theme');
    if (saved === 'system' || saved === 'light' || saved === 'dark') {
      preference = saved;
    }
  } catch {
    /* ignore */
  }

  const resolved = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
  root.dataset.appearance = preference;
  root.dataset.theme = resolved;

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) {
    themeMeta.setAttribute('content', resolved === 'dark' ? '#0b1215' : '#f4f7f6');
  }
})();
