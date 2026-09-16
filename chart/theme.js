// This small classic script runs before CSS is loaded, avoiding a theme flash.
// Keep it independent of the deferred dashboard bundle and API availability.
// Restore the browser's last selected theme, defaulting to dark.
(() => {
  const root = document.documentElement;
  const preferenceKey = 'home-energy-theme';
  let current = 'dark';
  let button;

  try {
    const saved = localStorage.getItem(preferenceKey);
    if (saved === 'dark' || saved === 'light') current = saved;
  } catch {
    // Storage can be unavailable; the theme still works for this page.
  }

  function reflect() {
    root.dataset.theme = current;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = current === 'dark' ? '#101e19' : '#f3f5f1';
    if (button) {
      const next = current === 'dark' ? 'light' : 'dark';
      button.setAttribute('aria-label', `Switch to ${next} theme`);
      button.title = `Switch to ${next} theme`;
    }
  }

  function setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return current;
    current = theme;
    try { localStorage.setItem(preferenceKey, current); } catch {
      // Keep the chosen theme usable even if the browser cannot save it.
    }
    reflect();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: current } }));
    return current;
  }

  function toggle() { return setTheme(current === 'dark' ? 'light' : 'dark'); }
  function initialize() {
    if (!button) {
      button = document.getElementById('theme-toggle');
      button?.addEventListener('click', toggle);
    }
    reflect();
  }

  reflect();
  window.homeEnergyTheme = { get current() { return current; }, toggle, setTheme, initialize };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
