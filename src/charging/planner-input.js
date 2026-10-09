const fields = (object, names) => Object.fromEntries(names.map(name => [name, object?.[name]]));

// Transport only the planner's inputs. Native readback clocks, diagnostics and
// earlier plan output do not change a numerical search or belong in its cache.
export function chargingPlannerInput(options) {
  const supply = options.supply;
  const configuredBudget = Array.isArray(supply?.configuredBudgetCurrentA)
    && supply.configuredBudgetCurrentA.length === 3 && supply.configuredBudgetCurrentA.every(value => Number.isFinite(value) && value >= 0);
  return { ...options,
    chargers: (options.chargers ?? []).map(charger => ({
      ...fields(charger, ['id', 'label', 'requiredGridKwh', 'referenceGridKwh', 'deadlineAt']),
      sessionCost: fields(charger.sessionCost, ['recordedGridKwh']),
      settings: fields(charger.settings, ['enabled']),
      capabilities: fields(charger.capabilities, ['scheduling', 'currentControl', 'externalLoadBalancing', 'maxSchedulePeriods', 'localClockSchedule']),
      configuration: fields(charger.configuration, ['maximumCurrentA', 'limiterEnabled', 'fallbackCurrentA']),
      request: fields(charger.request, ['chargeNow']),
      control: { ...fields(charger.control, ['released', 'provisional']),
        phase: ['released', 'charging'].includes(charger.control?.phase) ? charger.control.phase : null,
        errorCode: Boolean(charger.control?.errorCode),
        manual: charger.control?.manual ? fields(charger.control.manual, ['kind', 'resumeAt']) : null },
      telemetry: { ...fields(charger.telemetry, ['manualStop', 'scheduledEndKind', 'providerConnected', 'currentSharingActive']),
        ...(supply === undefined ? { supply: charger.telemetry?.supply } : {}) },
      values: Object.fromEntries(['connected', 'charging', 'currentA', 'maximumCurrentA', 'actualCurrentA',
        'voltageV', 'powerKw', 'minimumSoc', 'vehicleCeilingSoc', 'soc', 'scheduledStartAt',
        'scheduledEndAt', 'vehicleNotBefore', 'nativeCurrentA', 'vehicleCurrentA'].map(key => [key,
        key === 'soc' ? charger.values?.soc : fields(charger.values?.[key], ['value', 'available', 'assumed'])])),
    })),
    ...(supply === undefined ? {} : { supply: {
      ...fields(supply, ['configuredBudgetCurrentA', 'allocationA', 'voltageV',
        ...(!configuredBudget ? ['availableCurrentA', 'propertyCurrentA', 'chargerCurrentA'] : [])]),
      ...(Object.hasOwn(supply ?? {}, 'planningVoltageV') ? { planningVoltageV: supply.planningVoltageV } : {}),
      ...(!configuredBudget ? { estimate: fields(supply?.estimate, ['available', 'budgetCurrentA', 'quality']) } : {}),
    } }),
  };
}

export function chargingPlanValidUntil(options, result) {
  const boundaries = [options.now + 30_000,
    ...(result.allocations ?? []).flatMap(row => [row.start, row.end]),
    ...Object.values(result.plans ?? {}).flatMap(plan => [plan.deadlineAt,
      ...(plan.periods ?? []).flatMap(row => [row.startAt, row.endAt])]),
    ...(options.chargers ?? []).map(charger => charger.control?.manual?.resumeAt),
  ].filter(at => Number.isFinite(at) && at > options.now);
  return Math.min(...boundaries);
}
