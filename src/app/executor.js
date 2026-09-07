import { HEATING_COMMANDS } from '../control/mqtt.js';

// All device command ownership is here; acquisition never receives this object.
// Physical publishing is available only for an explicit, one-shot manual test.
export class Executor {
  constructor({ input, store, plant, commandTransport = null }) {
    this.input = input;
    this.store = store;
    this.plant = plant;
    this.commandTransport = commandTransport;
  }
  execute(decision, { mode, now, manualTest = false }) {
    if (!['monitoring', 'shadow', 'active'].includes(mode)) throw new Error('Invalid execution mode');
    if (manualTest) {
      if (!['mqtt', 'providers'].includes(this.input) || !this.commandTransport) throw new Error('Real MQTT tests require live input and a configured MQTT broker.');
      return this.sendCommands(decision.commands, { now, physical: true });
    }
    if (mode === 'active' && this.input !== 'simulated') throw new Error('Active physical control is not commissioned in this release');
    if (mode === 'monitoring') return { status: 'monitoring', sent: false, actual: null };
    if (mode === 'shadow') return { status: 'shadow', sent: false, actual: null };
    return this.sendCommands(decision.commands, { now });
  }
  sendCommands(commands, { now, physical = false }) {
    if (!Array.isArray(commands) || !commands.length || commands.some(command => !HEATING_COMMANDS.includes(command))) throw new Error('Invalid heating command');
    if (physical) return this.commandTransport.publish(commands);
    const actual = this.plant.apply(commands, now);
    this.store.event('simulated-command-readback', { commands, actual }, now);
    return { status: 'simulated', sent: true, actual };
  }
}
