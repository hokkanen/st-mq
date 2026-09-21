/** Shared learning disclosures. Update text in place so polling never closes a
 * reader's explanation, replaces focused controls or resets a sensor form. */
function setText(node, value) {
  const text = value == null ? '' : String(value);
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text;
}

function updateReference(parent, className, value, document) {
  let node = parent.querySelector(`.${className}`), href;
  try {
    const url = new URL(value?.href);
    if (url.protocol === 'https:') href = url.href;
  } catch {}
  if (!href) { node?.remove(); return; }
  if (!node) {
    node = document.createElement('a'); node.className = className;
    node.target = '_blank'; node.rel = 'noopener noreferrer'; parent.append(node);
  }
  if (node.href !== href) node.href = href;
  setText(node, value.label || href);
}

function renderCalculation(body, calculation, document) {
  let fold = body.querySelector('.learning-calculation');
  if (!calculation) { fold?.remove(); return; }
  if (!fold) {
    fold = document.createElement('details'); fold.className = 'learning-calculation';
    const summary = document.createElement('summary');
    const content = document.createElement('div'); content.className = 'learning-calculation-body';
    const equations = document.createElement('div'); equations.className = 'learning-equations';
    const notes = document.createElement('div'); notes.className = 'learning-calculation-notes';
    content.append(equations, notes); fold.append(summary, content);
    body.insertBefore(fold, body.querySelector('.learning-entry-evidence'));
  }
  setText(fold.querySelector('summary'), calculation.summary || 'Calculation');
  const equations = fold.querySelector('.learning-equations');
  const existing = [...equations.children];
  for (const [index, equation] of (calculation.equations ?? []).entries()) {
    let node = existing[index];
    if (!node) {
      node = document.createElement('div'); node.className = 'learning-equation';
      for (const field of ['label', 'expression', 'legend']) {
        const item = document.createElement(field === 'expression' ? 'code' : 'p');
        item.className = `learning-equation-${field}`; node.append(item);
      }
      equations.append(node);
    }
    for (const field of ['label', 'expression', 'legend'])
      setText(node.querySelector(`.learning-equation-${field}`), equation[field]);
  }
  for (const node of existing.slice(calculation.equations?.length ?? 0)) node.remove();
  const notes = fold.querySelector('.learning-calculation-notes');
  const paragraphs = [...notes.children];
  for (const [index, paragraph] of (calculation.paragraphs ?? []).entries()) {
    const node = paragraphs[index] ?? document.createElement('p');
    if (!node.parentNode) notes.append(node);
    setText(node, paragraph);
  }
  for (const node of paragraphs.slice(calculation.paragraphs?.length ?? 0)) node.remove();
  updateReference(fold.querySelector('.learning-calculation-body'), 'learning-calculation-reference',
    calculation.reference, document);
}

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
  for (const row of rows) {
    if (row.group && row.group !== group) {
      group = row.group;
      const heading = place(`group:${group}`, () => {
        const node = document.createElement('h3'); node.className = 'learning-row-group'; return node;
      });
      setText(heading, group);
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
      setText(node.querySelector(`.learning-entry-${field}`), row[field]);
    const body = node.querySelector('.learning-entry-body');
    renderCalculation(body, row.calculation, document);
    updateReference(body, 'learning-entry-reference', row.reference, document);
    node.classList.toggle('learning-entry-unavailable', row.available === false);
    if (row.modelInput) node.dataset.modelInput = row.modelInput;
  }
  for (const node of existing.values()) if (!keep.has(node)) node.remove();
}
