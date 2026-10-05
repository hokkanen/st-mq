/** Isolate pair storage/runtime tests from host networking. Real stream and
 * handover ownership are exercised in pair-mqtt-frontend.test.js. */
export function fixtureMqttFrontend() {
  let listening = false;
  return {
    prepare: async () => {},
    handoverRequirements: () => ({ version: 1, protocol: 'mqtt:', port: 1883 }),
    start: async () => { listening = true; },
    stop: async () => { listening = false; },
    status: () => ({ listening, ready: listening, connections: 0, error: null }),
  };
}

export function fixtureMqttSourceContext() {
  return { activate: async () => {}, requirements: () => ({ version: 1, fixture: true }),
    prepare: async () => {}, verify: async () => {}, authorize: async () => {}, authorizePromotion: async () => {} };
}
