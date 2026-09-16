/** Page fullscreen is independent of the chart inspection layout. Browser-level
 * fullscreen (for example F11) is not exposed consistently by this API. */
const desiredStates = new WeakMap();

export async function enterPageFullscreen(document, stillWanted = () => true) {
  desiredStates.set(document, stillWanted);
  await document.documentElement.requestFullscreen();
  // A chart can close while the browser is asking for permission. Reconcile
  // late entries with the latest intent, including a newer header entry/exit.
  if (!desiredStates.get(document)() && document.fullscreenElement === document.documentElement)
    await document.exitFullscreen();
}

export function exitPageFullscreen(document) {
  desiredStates.set(document, () => false);
  return document.exitFullscreen();
}

export function createPageFullscreen({ document, button }) {
  let pending = false;
  const supported = () => Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  function reflect() {
    const active = Boolean(document.fullscreenElement);
    const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
    button.dataset.fullscreen = String(active);
    button.setAttribute('aria-label', label);
    button.title = active || supported() ? label : 'Fullscreen is unavailable in this browser or embedded view';
    button.disabled = pending || (!active && !supported());
  }
  async function toggle() {
    if (pending) return;
    pending = true;
    reflect();
    let failed = false;
    try {
      if (document.fullscreenElement) await exitPageFullscreen(document);
      else if (supported()) await enterPageFullscreen(document);
    } catch {
      failed = true;
    } finally {
      pending = false;
      reflect();
      if (failed) button.title = 'Fullscreen could not be changed. Try again.';
    }
  }
  button.addEventListener('click', toggle);
  document.addEventListener('fullscreenchange', reflect);
  reflect();
  return {
    close() {
      button.removeEventListener('click', toggle);
      document.removeEventListener('fullscreenchange', reflect);
    },
  };
}
