import { initialAdaptiveModel } from '../../src/control/adaptive-learning.js';

export const EXPLORER_NOW = Date.parse('2026-01-01T00:00:00Z');
export function heatingExplorerFixture({ hours = 12, validatedHours = 8, price = 500,
  maxReductionHours = 4, maxDropC = 2, outdoorC = 0 } = {}) {
  const now = EXPLORER_NOW, HOUR = 3_600_000;
  const model = initialAdaptiveModel({ heatPumpModelConfirmed: true });
  model.uncertainty = { points: [{ hours: 48, errorC: .1 }], extrapolationCPerHour: .01 };
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
  model.equipmentResponse = { phases: { reduction: { ratio: 0, trainingEpisodes: 3, treatmentKey: 'reduction-only-v1' } },
    validation: { phases: { reduction: { accepted: true, episodes: 3, maxDurationHours: validatedHours, treatmentKey: 'reduction-only-v1' } } } };
  model.forecastValidation = { accepted: true, episodes: 3, maxReductionHours: validatedHours };
  const intervals = Array.from({ length: hours * 4 }, (_, i) => ({ start: now + i * HOUR / 4,
    end: now + (i + 1) * HOUR / 4, outdoorC, solarRadiationWm2: 0,
    allInCentsPerKWh: i < 24 ? price : 1, issuedAt: now }));
  return { now, snapshotId: 'synthetic-explorer', observations: { indoor: { value: 21, observedAt: now, stale: false } },
    prices: intervals.map(row => ({ start: row.start, end: row.end, allInCentsPerKWh: row.allInCentsPerKWh })),
    forecast: intervals.map(row => ({ start: row.start, end: row.end, outdoorC: row.outdoorC,
      solarRadiationWm2: row.solarRadiationWm2, issuedAt: row.issuedAt })),
    checkpoint: { model, baselineC: 21, health: { usableSamples: 100 } },
    config: { learningTrials: false, maxReductionHours, maxAwayReductionHours: 12, maxPreheatHours: 2 },
    settings: { savingsStrategy: 'balanced', comfort: { targetC: 21, maxDropC, maxRiseC: 2 }, occupancy: { mode: 'occupied' } },
    equipment: { supplyC: 35, brineC: 0, nativeAuxAllowed: false, h66Available: true,
      compressorOn: 1, dhwRouting: 0, preheatAvailable: false },
    thermalState: { indoorC: 21, reserveC: 25.725 }, trialBudgetRemainingCents: 0 };
}
