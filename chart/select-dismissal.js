/** Finish native dropdown selections on pointer devices, including DeX.
 * Delegate so controls created or replaced after a status update are covered. */
export function createSelectDismissal(document) {
  let pointerSelect = null;
  const reset = () => { pointerSelect = null; };
  const pointer = event => {
    const select = event.target.closest?.('select');
    pointerSelect = select && !select.disabled && !select.multiple && select.size <= 1 ? select : null;
  };
  const focusout = event => { if (event.target === pointerSelect) reset(); };
  const change = event => {
    const select = pointerSelect;
    reset();
    // A control may already have moved focus to its next editor.
    if (select === event.target && document.activeElement === select) select.blur();
  };
  const listeners = [['pointerdown', pointer], ['keydown', reset], ['pointercancel', reset],
    ['focusout', focusout], ['change', change]];
  for (const [type, listener] of listeners) document.addEventListener(type, listener);
  return { close() {
    reset();
    for (const [type, listener] of listeners) document.removeEventListener(type, listener);
  } };
}
