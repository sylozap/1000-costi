// Тема оформления. Подключается в <head> до отрисовки, чтобы не мигала тёмная тема.
// По умолчанию — как в Telegram (или в системе); выбор игрока запоминается на устройстве.
(function () {
  const tg = window.Telegram?.WebApp;
  const BG = { dark: '#0d1712', light: '#f3efe4' };
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* без localStorage */ }

  function auto() {
    if (tg?.colorScheme === 'light' || tg?.colorScheme === 'dark') return tg.colorScheme;
    return media?.matches ? 'light' : 'dark';
  }

  function current() { return saved === 'light' || saved === 'dark' ? saved : auto(); }

  function apply() {
    const theme = current();
    document.documentElement.dataset.theme = theme;
    try {
      tg?.setHeaderColor?.(BG[theme]);
      tg?.setBackgroundColor?.(BG[theme]);
    } catch (e) { /* старые клиенты */ }
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  tg?.onEvent?.('themeChanged', () => { if (!saved) apply(); });
  media?.addEventListener?.('change', () => { if (!saved) apply(); });

  window.appTheme = {
    get: current,
    toggle() {
      saved = current() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', saved); } catch (e) { /* без localStorage */ }
      apply();
    },
  };
  apply();
})();
