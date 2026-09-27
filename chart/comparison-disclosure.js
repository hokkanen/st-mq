/** Keep comparison cards mounted in an ordinary panel across disclosure cycles. */
export function createComparisonDisclosure({ button, content, onOpen = () => {} }) {
  function reflect() {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(open));
    content.hidden = !open;
    return open;
  }
  function toggle() {
    button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') !== 'true'));
    if (reflect()) onOpen();
  }
  reflect();
  button.addEventListener('click', toggle);
  return { close: () => button.removeEventListener('click', toggle) };
}
