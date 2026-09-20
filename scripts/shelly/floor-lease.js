// Install as an enabled boot script on each dedicated Shelly Pro 2 v0.
// Before installation read docs/floor-preheat.md; OFF must restore independent
// thermostat authority. Native input control, schedules and other ON writers
// must not operate these override outputs.
// Uses the device's MQTT topic prefix. No household identifiers belong here.
var FLOOR_PROTOCOL = 'stmq-floor-v1';
var FLOOR_BOOT_KEY = 'stmq_floor_boot_v1';
var FLOOR_MAX_SECONDS = 900;
var floorPrefix = Shelly.getComponentConfig('mqtt').topic_prefix;
var floorReady = false;
var floorBoot = 0;
var floorSequence = 0;
var floorOwner = null;
var floorClosedOwner = null;
var floorExpires = 0;
var floorMonoExpires = 0;
var floorAnchor = null;
var floorOperation = 0;
var floorBusy = false;
var floorLastStatus = 0;

function floorClock() {
  var sys = Shelly.getComponentStatus('sys');
  if (!sys || typeof sys.unixtime !== 'number' || sys.unixtime < 1700000000 || typeof sys.uptime !== 'number') return null;
  if (floorAnchor !== null && Math.abs(sys.unixtime - sys.uptime - floorAnchor) > 5) return null;
  return sys;
}
function floorConfigOk() {
  for (var i = 0; i < 2; i++) {
    var config = Shelly.getComponentConfig('switch', i);
    if (!config || config.initial_state !== 'off' || config.auto_on !== false || config.auto_off !== true
        || config.auto_off_delay > FLOOR_MAX_SECONDS || config.auto_off_delay < 1 || config.in_mode !== 'detached') return false;
  }
  return true;
}
function floorStatus(requestId) {
  var sys = Shelly.getComponentStatus('sys');
  var channels = [];
  for (var i = 0; i < 2; i++) {
    var output = Shelly.getComponentStatus('switch', i);
    channels.push({ id: i, output: output ? output.output : null, error: !output || (output.errors && output.errors.length > 0) ? true : false });
  }
  MQTT.publish(floorPrefix + '/stmq/floor/status', JSON.stringify({ protocol: FLOOR_PROTOCOL,
    requestId: requestId || null, boot: floorBoot, sequence: floorSequence,
    ready: floorReady && floorConfigOk(), clockOk: floorClock() !== null,
    at: sys ? sys.unixtime : null, owner: floorOwner, expiresAt: floorExpires, channels: channels }), 1, false);
}
function floorOff(requestId) {
  if (floorOwner !== null) floorClosedOwner = floorOwner;
  floorOwner = null; floorExpires = 0; floorMonoExpires = 0;
  floorOperation++; floorBusy = true;
  var operation = floorOperation;
  // Attempt both releases even if the first RPC fails. The watchdog retries.
  Shelly.call('Switch.Set', { id: 0, on: false }, function() {
    Shelly.call('Switch.Set', { id: 1, on: false }, function() {
      if (operation === floorOperation) floorBusy = false;
      floorStatus(requestId);
    });
  });
}
function floorLease(command) {
  var sys = floorClock();
  if (!floorReady || !floorConfigOk() || !sys || command.boot !== floorBoot
      || typeof command.sequence !== 'number' || command.sequence % 1 !== 0 || command.sequence < 1
      || typeof command.owner !== 'string' || command.owner.length < 1 || command.owner.length > 160
      || typeof command.issuedAt !== 'number' || command.issuedAt > sys.unixtime + 5 || sys.unixtime - command.issuedAt > 30
      || typeof command.expiresAt !== 'number' || command.expiresAt <= sys.unixtime
      || command.expiresAt > command.issuedAt + FLOOR_MAX_SECONDS
      || typeof command.until !== 'number' || command.expiresAt > command.until
      || command.owner === floorClosedOwner || (floorOwner !== null && floorOwner !== command.owner)) {
    floorStatus(command.requestId); return;
  }
  // MQTT duplicates neither restart outputs nor extend timers.
  if (command.sequence <= floorSequence || floorBusy) { floorStatus(command.requestId); return; }
  floorSequence = command.sequence;
  floorOwner = command.owner; floorExpires = command.expiresAt;
  floorMonoExpires = sys.uptime + command.expiresAt - sys.unixtime;
  floorAnchor = sys.unixtime - sys.uptime;
  floorOperation++; floorBusy = true;
  var operation = floorOperation;
  Shelly.call('Switch.Set', { id: 0, on: true, toggle_after: command.expiresAt - sys.unixtime }, function(result, error) {
    if (operation !== floorOperation) return;
    var current = floorClock();
    if (error || !current || current.unixtime >= floorExpires) { floorOff(command.requestId); return; }
    Shelly.call('Switch.Set', { id: 1, on: true, toggle_after: command.expiresAt - current.unixtime }, function(result2, error2) {
      if (operation !== floorOperation) return;
      floorBusy = false;
      if (error2) { floorOff(command.requestId); return; }
      floorStatus(command.requestId);
    });
  });
}
function floorCommand(topic, message) {
  var command;
  try { command = JSON.parse(message); } catch (error) { return; }
  if (!command || command.protocol !== FLOOR_PROTOCOL || typeof command.requestId !== 'string') return;
  if (command.action === 'probe') { floorStatus(command.requestId); return; }
  if (command.action === 'release') {
    if (typeof command.sequence === 'number' && command.sequence % 1 === 0 && command.sequence > floorSequence)
      floorSequence = command.sequence;
    floorOff(command.requestId); return;
  }
  if (command.action === 'lease') floorLease(command);
}
function floorWatchdog() {
  var sys = floorClock();
  var raw = Shelly.getComponentStatus('sys');
  var s0 = Shelly.getComponentStatus('switch', 0);
  var s1 = Shelly.getComponentStatus('switch', 1);
  var on = (s0 && s0.output) || (s1 && s1.output);
  if (!floorBusy && ((floorOwner !== null && (!sys || !floorConfigOk() || sys.unixtime >= floorExpires || sys.uptime >= floorMonoExpires
      || !s0 || !s1 || !s0.output || !s1.output || (s0.errors && s0.errors.length) || (s1.errors && s1.errors.length)))
      || (floorOwner === null && on))) floorOff(null);
  // A clock step ends the old lease; a new lease may be commissioned against
  // the new stable clock only after the outputs are released.
  if (floorOwner === null && !floorBusy) floorAnchor = null;
  if (raw && raw.uptime - floorLastStatus >= 30) { floorLastStatus = raw.uptime; floorStatus(null); }
}

// Safe boot config is a commissioning prerequisite, checked continuously.
// A durable boot generation prevents replay across device or script restarts.
// Initialize KVS key to 0 once while outputs are disconnected; never reset it
// on a commissioned device. KVS read/write failure leaves lease acceptance OFF.
floorOff(null);
MQTT.subscribe(floorPrefix + '/stmq/floor/command', floorCommand);
Timer.set(1000, true, floorWatchdog);
Shelly.call('KVS.Get', { key: FLOOR_BOOT_KEY }, function(result, error) {
  if (error || !result || typeof result.value !== 'number' || result.value < 0 || result.value % 1 !== 0) return;
  var nextBoot = result.value + 1;
  Shelly.call('KVS.Set', { key: FLOOR_BOOT_KEY, value: nextBoot }, function(saved, saveError) {
    if (saveError) return;
    floorBoot = nextBoot; floorReady = floorConfigOk(); floorStatus(null);
  });
});
