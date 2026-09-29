// Unrelated MQTT scenarios choose their own equipment. Explicit empty topics
// also override public defaults when a reload fixture is read through loadConfig.
export function isolatedGarageAdapter() {
  return { driver: 'shelly-cn105', stateTopic: '', telemetryTopic: '', commandTopic: '' };
}
