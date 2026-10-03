const HOUR = 3_600_000;
const reading = value => ({ value, available: value !== null, assumed: false });

/** Synthetic full-day search with both chargers and six household scenarios.
 * Shared by offline throughput and worker responsiveness checks. */
export function chargingPlannerWorkload({ priority = 'balanced' } = {}) {
  const now = Date.parse('2026-10-03T00:00:00Z');
  const chargers = ['charger1', 'charger2'].map((id, index) => ({
    id, label: id, requiredGridKwh: index ? 38 : 44, deadlineAt: now + 24 * HOUR,
    settings: { enabled: true },
    capabilities: { scheduling: true, currentControl: index === 1, externalLoadBalancing: index === 0 },
    values: { connected: reading(true), charging: reading(false), currentA: reading(16), maximumCurrentA: reading(16),
      actualCurrentA: reading(0), voltageV: reading(230), powerKw: reading(0), minimumSoc: reading(80),
      vehicleCeilingSoc: reading(80), soc: reading(20) },
    control: {}, telemetry: {},
  }));
  return { now, chargers, priority, supply: { configuredBudgetCurrentA: [25, 25, 25] },
    prices: Array.from({ length: 96 }, (_, index) => ({
      start: now + index * HOUR / 4, end: now + (index + 1) * HOUR / 4,
      priceCtPerKwh: 5 + index * 7 % 19,
    })),
    household: Array.from({ length: 96 }, (_, index) => ({
      start: now + index * HOUR / 4, end: now + (index + 1) * HOUR / 4,
      phaseCurrentA: [5, 6, 4],
      scenarios: Array.from({ length: 6 }, (_, scenario) => ({
        phaseCurrentA: [2 + (index + scenario) % 8, 3 + (index * 2 + scenario) % 7, 1 + (index + scenario * 3) % 8],
        weight: scenario + 1,
      })),
    })),
  };
}
