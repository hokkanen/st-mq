// This small classic script runs before CSS is loaded, avoiding a theme flash.
// Keep it independent of the deferred dashboard bundle and API availability.
(() => {
  const key = 'home-energy-theme';
  const root = document.documentElement;
  let current = 'dark';
  try { if (localStorage.getItem(key) === 'light') current = 'light'; } catch { /* Storage can be unavailable in private browser contexts. */ }
  let button;

  function reflect() {
    root.dataset.theme = current;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = current === 'dark' ? '#101e19' : '#f3f5f1';
    if (button) {
      const next = current === 'dark' ? 'light' : 'dark';
      button.textContent = `${next === 'light' ? 'Light' : 'Dark'} theme`;
      button.setAttribute('aria-label', `Switch to ${next} theme`);
      button.title = `Switch to ${next} theme`;
    }
  }

  function setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return current;
    current = theme;
    try { localStorage.setItem(key, current); } catch { /* The toggle still works without persistence. */ }
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
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    // Clearing preferences restores the default dark theme across open tabs.
    current = event.newValue === 'light' ? 'light' : 'dark';
    reflect();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: current } }));
  });
})();
