const finite = Number.isFinite;
const timestamp = value => value == null || value === '' || !finite(new Date(value).getTime()) ? null : new Date(value).getTime();
const nativeForecast = forecast => ['forecast', 'uncertain'].includes(forecast?.state)
  && ['automatic-current-forecast', 'vehicle-stop-unknown'].includes(forecast.reason)
  || forecast?.state === 'forecast' || forecast?.controlled === false && forecast.state !== 'planned';

/** A bounded summary notice; its full explanation remains available on demand. */
export function chargingNotice(charger, view, summary) {
  const detail = [view.problem, view.priority, view.readiness, ...view.notes].filter(Boolean).join('\n\n');
  if (view.problem || summary.roleState === 'uncertain') return { label: 'Charger needs attention',
    detail: [...new Set([view.problem, summary.roleDetail, view.priority, ...view.notes].filter(Boolean))].join('\n\n'), state: 'attention' };
  if (charger.request?.chargeNow === true && view.showMetrics && !view.yielded) return { label: 'Charge now selected until unplugging',
    detail: `${summary.roleDetail} The activity above shows whether the vehicle is actually charging.`, state: 'manual' };
  if (view.risk) return { label: 'Target may be late', detail, state: 'attention' };
  if (view.yielded) {
    const priority = view.priority || (!view.showMetrics ? view.event : '');
    const resumption = priority.match(/^Automatic control resumes (.+?)(?: at the ready-by boundary)?\.$/);
    return { label: resumption ? `Automatic resumes ${resumption[1]}` : 'Manual control has priority',
      detail: [...new Set([priority, detail || summary.roleDetail].filter(Boolean))].join('\n\n'), state: 'manual' };
  }
  if (view.notes.length) return { label: 'Estimate has limitations', detail, state: 'attention' };
  if (!view.showMetrics) return { label: view.supported && charger.settings?.enabled !== true ? 'Automatic charging is off'
    : charger.values?.connected?.value === false ? 'Ready for the next connection' : 'Waiting for a connection reading',
    detail: 'Charge, progress and cost will appear when a vehicle is confirmed connected. Saved settings remain available below.', state: 'quiet' };
  if (summary.completion.value === 'Reached') return { label: 'Target reached · vehicle decides when to stop',
    detail: 'No more energy is needed for the displayed target. The vehicle may continue to its own charge limit.', state: 'good' };
  if (summary.completion.detail === 'Expected on time') return { label: ['Expected on time', view.periodCount].filter(Boolean).join(' · '),
    detail: 'The current forecast reaches the target by the ready-by time. Estimates change with available power and vehicle readings.', state: 'good' };
  if (view.deadline) return { label: 'Checking target readiness', detail: summary.completion.detail, state: 'quiet' };
  return { label: view.supported ? charger.settings?.enabled === true ? 'Automatic charging is on' : 'Automatic charging is off' : 'Vehicle controls charging',
    detail: `${summary.roleDetail} ${view.readingTime || ''}`.trim(), state: 'quiet' };
}

/** Show the durable connection total, including already delivered energy. */
export function chargingCost(charger, view, summary, { now = Date.now(), prices = [] } = {}) {
  if (view.showMetrics && finite(charger.sessionCost?.totalCents)) return {
    value: `€${(charger.sessionCost.totalCents / 100).toFixed(2)}`,
    detail: 'Estimated total electricity cost from plugging in through the target, including charging losses. Delivered energy remains included after the target and any further charging adds to the cost.'
      + (charger.sessionCost.estimated ? ' Missing forecast or rate coverage uses the last available cost estimate.' : '') };
  const forecast = charger.forecast, remaining = charger.progress?.remainingGridKwh ?? charger.requiredGridKwh ?? forecast?.requiredGridKwh;
  const unavailable = { value: 'No estimate', detail: 'A current charging forecast and electricity rates covering the time to target are needed.' };
  if (!view.showMetrics || !finite(remaining)) return unavailable;
  if (remaining <= 0) return { value: '€0.00', detail: 'No additional grid energy is needed to reach the target.' };
  const finish = summary.completion.at;
  if (summary.roleState === 'uncertain' || !finite(finish) || finish <= now) return unavailable;
  const planned = view.rows.find(([label]) => label === 'Estimated cost to target');
  if (planned) return { value: planned[1], detail: 'Estimated electricity cost to reach the target during the planned charging periods.' };
  const start = Math.max(now, timestamp(forecast?.startAt) ?? Infinity);
  if (!nativeForecast(forecast) || finish <= start) return unavailable;
  let cursor = start, cents = 0;
  const intervals = (Array.isArray(prices) ? prices : []).map(row => ({ start: timestamp(row.start), end: timestamp(row.end),
    price: row.allInCentsPerKWh ?? row.priceCtPerKwh ?? row.totalCtPerKwh ?? row.price }))
    .filter(row => row.start !== null && row.end !== null && row.end > row.start && finite(row.price))
    .sort((a, b) => a.start - b.start);
  for (const interval of intervals) {
    if (interval.end <= cursor) continue;
    if (interval.start > cursor) break;
    const end = Math.min(finish, interval.end);
    cents += remaining * (end - cursor) / (finish - start) * interval.price;
    cursor = end;
    if (cursor >= finish) return { value: `€${(cents / 100).toFixed(2)}`,
      detail: 'Remaining grid energy, including charging losses, priced at the electricity rates during the forecast charging time.' };
  }
  return unavailable;
}

/** Keep charger role, present activity and estimated completion separate. */
export function chargerSummary(charger, view, { now = Date.now(), formatTime = value => new Date(value).toISOString() } = {}) {
  const values = charger.values ?? {}, control = charger.control ?? {}, plan = charger.plan ?? {}, forecast = charger.forecast;
  const supported = charger.capabilities?.scheduling === true, enabled = supported && charger.settings?.enabled === true;
  const connected = values.connected?.value === true, charging = connected && values.charging?.value === true;
  const chargeNow = connected && charger.request?.chargeNow === true;
  const phase = control.phase ?? '', manual = enabled || chargeNow ? control.manual ?? control.manualOverride : null;
  const yielded = (enabled || chargeNow) && (['yielded', 'manual'].includes(phase) || Boolean(manual));
  const resumeAt = timestamp(manual?.resumeAt ?? manual?.expiresAt ?? manual?.windowEndAt ?? manual?.endsAt ?? manual?.endAt);
  const handoverPending = yielded && manual?.kind !== 'unknown' && resumeAt !== null && resumeAt <= now;
  const handoverUnconfirmed = supported && !enabled && control.handoverConfirmed === false;
  const uncertain = (enabled || chargeNow) && (['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed', 'unconfirmed'].includes(phase)
    || control.confirmed === false || Boolean(control.errorCode) || manual?.kind === 'unknown'
    || /update awaiting confirmation/.test(view.event ?? ''));
  let roleLabel = enabled ? 'Controlled' : 'Observed', roleState = enabled ? 'controlled' : 'observed';
  let roleDetail = enabled ? 'Automatic charging chooses charging periods for the ready-by time.'
    : supported ? 'Automatic charging is off. The charger’s own activity is observed.' : 'Charging is observed; this integration cannot set its schedule.';
  if (handoverUnconfirmed || handoverPending || uncertain) {
    roleLabel = handoverUnconfirmed ? 'Handover unconfirmed' : handoverPending ? 'Handover pending' : 'Control unconfirmed';
    roleState = 'uncertain';
    roleDetail = control.reason || (handoverUnconfirmed ? 'Automatic charging is off, but the charger has not confirmed the handover.'
      : handoverPending ? `Manual priority has ended. Waiting for charger confirmation.${enabled ? '' : ' Automatic charging remains off.'}`
        : chargeNow ? 'The immediate charging instruction is awaiting confirmation.' : 'The charger’s current automatic instruction is awaiting confirmation.');
  } else if (chargeNow && !yielded) {
    roleLabel = 'Charge now'; roleState = 'manual';
    roleDetail = `Charging is requested until unplugging. Automatic charging remains ${enabled ? 'on' : 'off'}. Click “Charge now” again to end this request and use automatic charging.`;
  } else if (yielded) {
    roleLabel = 'Manual override'; roleState = 'manual';
    roleDetail = view.priority || 'An external charger change has priority over automatic charging.';
  }

  const remaining = charger.progress?.remainingGridKwh ?? charger.requiredGridKwh ?? forecast?.requiredGridKwh
    ?? plan.requiredGridKwh ?? forecast?.gridEnergyKwh;
  const reached = connected && finite(remaining) && remaining <= 0;
  const unavailable = detail => ({ value: enabled && !yielded ? 'Checking' : 'No estimate', detail, at: null });
  let completion;
  if (!connected) completion = { value: 'No estimate', detail: values.connected?.value === false ? 'Not connected' : 'Waiting for readings', at: null };
  else if (reached) completion = { value: 'Reached', detail: view.energyNote || 'Target reached', at: null };
  else if (roleState === 'uncertain') completion = { value: 'Checking', detail: roleLabel, at: null };
  else {
    // A current missing forecast explicitly invalidates an older plan estimate.
    const forecastAbsent = Object.hasOwn(charger, 'forecast') && forecast === null;
    const hasForecastFinish = forecast != null && Object.hasOwn(forecast, 'finishAt');
    const source = hasForecastFinish ? forecast : forecastAbsent ? null : plan;
    const finishAt = timestamp(source?.finishAt);
    const nativeStart = timestamp(values.scheduledStartAt?.value), nativeEnd = timestamp(values.scheduledEndAt?.value);
    const endKind = charger.scheduledEndKind ?? charger.telemetry?.scheduledEndKind ?? values.scheduledEndAt?.kind;
    const stopAt = ['enforced', 'scheduled-stop'].includes(endKind) ? nativeEnd : null;
    const manualEnd = timestamp(manual?.windowEndAt ?? manual?.endsAt ?? manual?.endAt);
    const boundary = yielded ? Math.min(manualEnd ?? Infinity, resumeAt ?? Infinity, stopAt ?? Infinity) : stopAt;
    const manualStart = timestamp(manual?.startsAt ?? manual?.startAt);
    const hasNativeActivity = charging || nativeStart !== null && (nativeStart >= now || stopAt !== null && stopAt > now)
      || yielded && manualStart !== null && (manualStart >= now || manualEnd !== null && manualEnd > now);
    const automaticPlan = plan.periods?.length > 0 || ['waiting', 'release'].includes(plan.state)
      || timestamp(plan.startAt) !== null && !['observing', 'disabled', 'manual', 'released'].includes(plan.state);
    const inactiveAutomaticSource = (!enabled || yielded) && (source === forecast
      ? !nativeForecast(forecast) && (forecast?.state === 'planned' || forecast?.controlled === true || automaticPlan)
      : !['observing', 'disabled', 'manual'].includes(plan.state));
    const inactivePlan = source === plan && (enabled && !yielded && ['observing', 'disabled', 'manual', 'disconnected', 'unavailable'].includes(plan.state)
      || timestamp(plan.deadlineAt) !== null && timestamp(plan.deadlineAt) <= now);
    const noForecast = !source || finishAt === null || finishAt <= now || inactiveAutomaticSource || inactivePlan
      || ['none', 'unavailable', 'preview'].includes(source.state)
      || (!enabled || yielded) && !hasNativeActivity || yielded && manual?.kind === 'stop';
    if (noForecast) completion = unavailable(view.risk ? 'Target at risk' : 'Estimate unavailable');
    else if (boundary !== null && boundary < finishAt && (!enabled || yielded)) completion = unavailable('Scheduled stop before target');
    else {
      const deadlineAt = timestamp(plan.deadlineAt ?? charger.deadlineAt);
      completion = { value: formatTime(finishAt), at: finishAt,
        detail: view.risk || enabled && !yielded && deadlineAt !== null && finishAt > deadlineAt ? 'Target at risk'
          : enabled && !yielded && view.readiness === 'Expected on time' ? 'Expected on time' : 'Estimated completion' };
    }
  }

  // The completion column owns the ETA. Status, pauses and manual windows remain
  // in the activity line, including when the old event carried a stale ETA.
  let activity = (view.event ?? '').replace(/ · (?:[\d.]+\s*%|Unknown) estimated .+$/, '');
  if (reached) activity = activity.replace(/ · target reached$/, '');
  if (charging && !/^Charging\b/i.test(activity)) activity = `Charging${activity ? ` · ${activity}` : ''}`;
  else if (view.state === 'Paused between periods') activity = `Paused between periods${activity ? ` · ${activity}` : ''}`;
  else if (!connected && !activity.startsWith(view.state ?? '')) activity = `${view.state}${activity ? ` · ${activity}` : ''}`;
  if (['Monitoring', 'Automatic charging OFF'].includes(activity)) activity = view.state || 'Waiting for readings';
  activity ||= view.state || 'Waiting for readings';
  const compactSummary = [roleLabel, activity, reached && !/target (?:already )?(?:met|reached)/i.test(activity) ? 'Target reached' : ''].filter(Boolean).join(' · ');
  return { roleLabel, roleDetail, roleState, activity, completion, compactSummary };
}
