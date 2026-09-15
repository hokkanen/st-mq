const finite = Number.isFinite;
const timestamp = value => value == null || value === '' || !finite(new Date(value).getTime()) ? null : new Date(value).getTime();
const nativeForecast = forecast => ['forecast', 'uncertain'].includes(forecast?.state)
  && ['automatic-current-forecast', 'vehicle-stop-unknown'].includes(forecast.reason)
  || forecast?.state === 'forecast' || forecast?.controlled === false && forecast.state !== 'planned';

/** Keep charger role, present activity and estimated completion separate. */
export function chargerSummary(charger, view, { now = Date.now(), formatTime = value => new Date(value).toISOString() } = {}) {
  const values = charger.values ?? {}, control = charger.control ?? {}, plan = charger.plan ?? {}, forecast = charger.forecast;
  const supported = charger.capabilities?.scheduling === true, enabled = supported && charger.settings?.enabled === true;
  const connected = values.connected?.value === true, charging = connected && values.charging?.value === true;
  const phase = control.phase ?? '', manual = enabled ? control.manual ?? control.manualOverride : null;
  const yielded = enabled && (['yielded', 'manual'].includes(phase) || Boolean(manual));
  const resumeAt = timestamp(manual?.resumeAt ?? manual?.expiresAt ?? manual?.windowEndAt ?? manual?.endsAt ?? manual?.endAt);
  const handoverPending = yielded && manual?.kind !== 'unknown' && resumeAt !== null && resumeAt <= now;
  const handoverUnconfirmed = supported && !enabled && control.handoverConfirmed === false;
  const uncertain = enabled && (['uncertain', 'ownership-uncertain', 'unavailable', 'pause-unconfirmed', 'unconfirmed'].includes(phase)
    || control.confirmed === false || Boolean(control.errorCode) || manual?.kind === 'unknown'
    || /update awaiting confirmation/.test(view.event ?? ''));
  let roleLabel = enabled ? 'Controlled' : 'Observed', roleState = enabled ? 'controlled' : 'observed';
  let roleDetail = enabled ? 'Automatic charging chooses charging periods for the ready-by time.'
    : supported ? 'Automatic charging is off. The charger’s own activity is observed.' : 'Charging is observed; this integration cannot set its schedule.';
  if (handoverUnconfirmed || handoverPending || uncertain) {
    roleLabel = handoverUnconfirmed ? 'Handover unconfirmed' : handoverPending ? 'Handover pending' : 'Control unconfirmed';
    roleState = 'uncertain';
    roleDetail = control.reason || (handoverUnconfirmed ? 'Automatic charging is off, but the charger has not confirmed the handover.'
      : handoverPending ? 'Manual priority has ended. Automatic control is waiting for confirmation.'
        : 'The charger’s current automatic instruction is awaiting confirmation.');
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
