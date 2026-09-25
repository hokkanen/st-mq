// Shared charger priority belongs to configuration. Dashboard entries are read-only.
export function createChargingPriority({ document }) {
  const entries = new Map();
  let charging;
  const make = (tag, text = '', className = '', id) => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    if (id) node.id = id;
    return node;
  };
  function refresh() {
    const selected = charging?.settings?.priority;
    const label = selected === 'balanced' ? 'Balanced'
      : charging?.chargers?.find(charger => charger.id === selected)?.label ?? 'Unavailable';
    for (const value of entries.values()) value.textContent = label;
  }
  return {
    createEntry(id) {
      const entry = make('div', '', 'charging-priority-entry', `${id}-shared-priority`);
      const text = make('span');
      text.append(make('strong', 'Charger priority'), make('small', 'Shared by both chargers · set in configuration'));
      const value = make('span', '', 'charging-priority-entry-value', `${id}-shared-priority-value`);
      entry.append(text, value); entries.set(id, value); refresh(); return entry;
    },
    removeEntry(id) { entries.delete(id); },
    update(next) { charging = next; refresh(); },
    close() { entries.clear(); },
  };
}
