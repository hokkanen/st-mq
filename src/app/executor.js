// This release intentionally has no physical command transport. All device
// command ownership is here; read-only acquisition never receives this object.
export class Executor {
  constructor({ input, store, plant }) {
    this.input = input;
    this.store = store;
    this.plant = plant;
  }
  execute(decision, { mode, now }) {
    if (!['monitoring', 'shadow', 'active'].includes(mode)) throw new Error('Invalid execution mode');
    if (mode === 'active' && this.input !== 'simulated') throw new Error('Active physical control is not commissioned in this release');
    if (mode === 'monitoring') return { status: 'monitoring', sent: false, actual: null };
    if (mode === 'shadow') return { status: 'shadow', sent: false, actual: null };
    const actual = this.plant.apply(decision.commands, now);
    this.store.event('simulated-command-readback', { commands: decision.commands, actual }, now);
    return { status: 'simulated', sent: true, actual };
  }
}
