// Artificial provider responses for whole-application browser/container checks.
// No credentials, provider requests or household data are used by this fixture.
export function providerFixture(now) {
  const HOUR = 3600_000;
  const observation = (source, signal, value, unit) => ({ source, device: 'synthetic-provider-fixture', signal, value, unit,
    sourceTime: now - 300_000, receivedAt: now, quality: [], raw: { fixture: true } });
  return {
    connections: { geoloc: { country_code: 'fi', latitude: 60.4, longitude: 25.6 },
      smartthings: { inside_temp_dev_id: 'synthetic-room' }, easee: { charger_id: 'synthetic-charger', equalizer_id: 'synthetic-equalizer' } },
    providerOptions: {
      http: { json() { throw new Error('Fixture must never call a provider'); }, text() { throw new Error('Fixture must never call a provider'); }, close() {} },
      devices: {
        temperatures: async () => [observation('smartthings', 'indoor_temperature', 21.2, 'degC')],
        easee: async () => ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase =>
          observation('easee', `${prefix}_current_l${phase}`, prefix === 'property' ? 10 : 3, 'A'))),
      },
      market: async () => ({ source: 'elering', issuedAt: null, fetchedAt: now,
        intervals: [{ start: now - HOUR, end: now + 6 * HOUR, spotCtPerKwh: 7, unit: 'c/kWh', vatIncluded: false, source: 'elering' }],
        acquisition: { primary: 'entsoe', selected: 'elering', fallbackUsed: true,
          attempts: [{ source: 'entsoe', status: 'error', error: 'HTTP-429', retryAfterMs: 2 * HOUR }, { source: 'elering', status: 'ok' }] } }),
      weather: async () => ({ source: 'fmi', issuedAt: now - HOUR, fetchedAt: now,
        forecast: [{ start: now - HOUR, end: now + 6 * HOUR, outdoorC: 9, issuedAt: now - HOUR,
          fetchedAt: now, issuedAtBasis: 'provider-result-time', source: 'fmi', unit: 'degC' }],
        acquisition: { primary: 'fmi', selected: 'fmi', fallbackUsed: false, attempts: [{ source: 'fmi', status: 'ok' }] } }),
      outdoor: async () => {
        const rows = [observation('fmi', 'outdoor_temperature', 10, 'degC')];
        rows.acquisition = { primary: 'fmi', selected: 'fmi', fallbackUsed: false, attempts: [{ source: 'fmi', status: 'ok' }] };
        return rows;
      },
    },
  };
}
