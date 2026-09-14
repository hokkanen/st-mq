/** Shared learning disclosures. Update text in place so polling never closes a
 * reader's explanation, replaces focused controls or resets a sensor form. */
export function renderLearningRows(root, rows = [], { document = root?.ownerDocument } = {}) {
  if (!root) return;
  const existing = new Map([...root.children].map(node => [node.dataset.learningKey, node]));
  const keep = new Set();
  let previous = null, group;
  const place = (key, create) => {
    const node = existing.get(key) ?? create();
    node.dataset.learningKey = key;
    keep.add(node);
    const next = previous ? previous.nextSibling : root.firstChild;
    if (next !== node) root.insertBefore(node, next);
    previous = node;
    return node;
  };
  const set = (node, value) => {
    const text = value ?? '';
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
  };
  for (const row of rows) {
    if (row.group && row.group !== group) {
      group = row.group;
      const heading = place(`group:${group}`, () => {
        const node = document.createElement('h3'); node.className = 'learning-row-group'; return node;
      });
      set(heading, group);
    }
    const node = place(row.key, () => {
      const fold = document.createElement('details'); fold.className = 'learning-entry';
      const summary = document.createElement('summary');
      const heading = document.createElement('span'); heading.className = 'learning-entry-heading';
      for (const field of ['title', 'provenance', 'summary']) {
        const item = document.createElement('span'); item.className = `learning-entry-${field}`; heading.append(item);
      }
      const value = document.createElement('span'); value.className = 'learning-entry-value';
      summary.append(heading, value);
      const body = document.createElement('div'); body.className = 'learning-entry-body';
      for (const field of ['detail', 'evidence']) {
        const item = document.createElement('p'); item.className = `learning-entry-${field}`; body.append(item);
      }
      fold.append(summary, body);
      return fold;
    });
    for (const field of ['title', 'value', 'provenance', 'summary', 'detail', 'evidence'])
      set(node.querySelector(`.learning-entry-${field}`), row[field]);
    node.classList.toggle('learning-entry-unavailable', row.available === false);
    if (row.modelInput) node.dataset.modelInput = row.modelInput;
  }
  for (const node of existing.values()) if (!keep.has(node)) node.remove();
}
