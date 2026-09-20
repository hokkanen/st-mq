const finite = Number.isFinite;
const rate = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;

function priceEnergy(intervals, prices) {
  let cents = 0, pricedKwh = 0, energyKwh = 0;
  for (const interval of intervals) {
    if (!finite(interval.energyKwh) || interval.end <= interval.start) continue;
    energyKwh += interval.energyKwh;
    let cursor = interval.start;
    for (const price of prices) {
      if (price.end <= cursor || price.start >= interval.end) continue;
      const start = Math.max(cursor, price.start), end = Math.min(interval.end, price.end);
      const kwh = interval.energyKwh * (end - start) / (interval.end - interval.start);
      cents += kwh * price.priceCtPerKwh; pricedKwh += kwh; cursor = end;
    }
  }
  return { cents, pricedKwh, unpricedKwh: Math.max(0, energyKwh - pricedKwh) };
}

/** Connection totals have a separate lifetime from the changing SoC reference.
 * Keep the applicable published rates through restart and midnight rollover. */
export function updateSessionCost(previous, charger, now, prices = [], readEnergy = () => null) {
  if (charger.values.connected.value === false) return null;
  if (charger.values.connected.value !== true && !previous) return null;
  const startAt = previous?.startAt ?? charger.progress?.connectionAt ?? now;
  const rates = [...new Map([...(previous?.prices ?? []), ...prices]
    .filter(row => finite(row.start) && finite(row.end) && row.end > startAt && row.end > row.start && finite(rate(row)))
    .map(row => [`${row.start}:${row.end}`, { start: row.start, end: row.end, priceCtPerKwh: rate(row) }])).values()]
    .sort((a, b) => a.start - b.start);
  const recorded = readEnergy({ id: charger.id, start: startAt, end: now });
  const actual = priceEnergy(recorded?.intervals ?? [], rates);
  const remaining = charger.progress?.remainingGridKwh ?? charger.requiredGridKwh;
  const requirementBasis = JSON.stringify([charger.values.minimumSoc?.value, charger.values.capacityKwh?.value,
    charger.configuration?.efficiency, charger.telemetry?.assignedVehicleSource ?? charger.values.soc?.source]);
  const recordedGridKwh = Math.max(previous?.recordedGridKwh ?? 0, recorded?.gridKwh ?? 0);
  const recordedIncrement = recordedGridKwh - (previous?.recordedGridKwh ?? 0);
  const progressIncrement = previous?.requirementBasis === requirementBasis
    ? Math.max(0, previous.remainingGridKwh - remaining) : 0;
  // New vehicle SoC can reveal charging while the recorder was unavailable.
  // This is a cost estimate only. Replace it as recorded energy catches up;
  // never present it as measured charger energy or credit it to the planner.
  const missingEnergy = !recorded || recorded.incomplete === true;
  const unrecordedGridKwh = missingEnergy
    ? Math.max(0, (previous?.unrecordedGridKwh ?? 0) + progressIncrement - recordedIncrement) : 0;
  const deliveredGridKwh = recordedGridKwh + unrecordedGridKwh;
  const plan = charger.plan, forecast = charger.forecast;
  const controlled = charger.settings.enabled && !charger.control?.manual;
  const accounting = controlled && Array.isArray(forecast?.accounting) ? forecast.accounting
    : controlled && ['waiting', 'release'].includes(plan?.state) ? plan.accounting : null;
  let future = accounting?.length ? priceEnergy(accounting, rates) : null;
  const finishAt = forecast?.finishAt, forecastStart = Math.max(now, forecast?.startAt ?? now);
  if (!future && remaining > 0 && finite(finishAt) && finishAt > forecastStart)
    future = priceEnergy([{ start: forecastStart, end: finishAt, energyKwh: remaining }], rates);
  const futureKwh = future ? future.pricedKwh + future.unpricedKwh : 0;
  const observedRate = future?.pricedKwh > 0 ? future.cents / future.pricedKwh
    : actual.pricedKwh > 0 ? actual.cents / actual.pricedKwh : null;
  // A paused/manual/temporarily unavailable forecast must not erase the
  // connection estimate. Reuse its last estimated unit cost, visibly marked.
  const unitPriceCt = observedRate ?? previous?.unitPriceCt
    ?? rates.find(row => row.start <= now && row.end > now)?.priceCtPerKwh ?? null;
  const accruedCents = !recorded || recorded.gridKwh < (previous?.recordedGridKwh ?? 0)
    ? (previous?.accruedCents ?? 0) + (unrecordedGridKwh - (previous?.unrecordedGridKwh ?? 0)) * (unitPriceCt ?? 0)
    : actual.cents + Math.max(0, deliveredGridKwh - actual.pricedKwh) * (unitPriceCt ?? 0);
  const futureCents = remaining <= 0 ? 0 : futureKwh > 0
    ? future.cents * remaining / futureKwh + future.unpricedKwh * remaining / futureKwh * (unitPriceCt ?? 0)
    : finite(unitPriceCt) ? remaining * unitPriceCt : null;
  const totalCents = finite(futureCents) && (deliveredGridKwh <= actual.pricedKwh + 1e-6 || finite(unitPriceCt))
    ? accruedCents + futureCents : previous?.totalCents ?? null;
  return { startAt, prices: rates, deliveredGridKwh, recordedGridKwh, unrecordedGridKwh, requirementBasis,
    accruedCents, remainingGridKwh: remaining,
    totalCents, unitPriceCt, estimated: deliveredGridKwh > actual.pricedKwh + 1e-6 || recorded?.incomplete === true
      || remaining > 0 && (!future || future.unpricedKwh > 1e-6 || futureKwh + 1e-6 < remaining), updatedAt: now };
}
