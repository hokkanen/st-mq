const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Compact current evidence, without converting missing counters into zero or
 * presenting temperature-model validation as proof of economic readiness. */
export function learningOverview(learning = {}) {
  const health = learning?.adaptive?.health ?? {};
  const reported = health.status ?? learning?.status;
  const usableSamples = count(health.usableSamples), acceptedFits = count(health.acceptedFits);
  let status = 'unavailable', title = 'Awaiting model status';
  let summary = 'Learning status is not available yet.';
  if (reported === 'prior-estimates') {
    status = 'initial'; title = 'Initial estimates';
    summary = 'The house model is collecting evidence before replacing its starting estimates.';
  } else if (reported === 'retained-previous') {
    status = 'retained'; title = 'Previous model retained';
    summary = 'The previous model stays in use while new observations are checked.';
  } else if (reported === 'learning') {
    status = 'learning'; title = 'Learning from observations';
    summary = 'New observations refine the house’s temperature model.';
  } else if (!reported && usableSamples !== null) {
    status = 'collecting'; title = 'Collecting observations';
    summary = 'Recorded observations are available; model validation is not reported yet.';
  }
  const readiness = learning?.readiness;
  if (status === 'learning' && readiness?.thermalValidated === true) {
    summary = readiness.actionValidated === true
      ? 'Temperature and action predictions have passed their independent checks. Savings remain estimates.'
      : readiness.actionValidated === false
        ? 'Temperature checks have passed. Heating-action forecasts are still being validated.'
        : 'Temperature checks have passed. Heating-action validation is not reported yet.';
  }
  return { status, title, summary, usableSamples, acceptedFits };
}

/** Scope follows loadConfig and the startup-only keys in reloadSettings.
 * Only the API can declare a source reloadable; an input mode alone cannot. */
export function settingsReloadScope(status = {}) {
  const reload = status?.settingsReload;
  const supported = reload?.available === true && reload?.unavailable !== true;
  const available = supported && reload?.busy !== true;
  const reloadable = [
    'Price-control mode, comfort limits and learning settings',
    'Electricity rates',
    'Recording interval and storage budget',
  ];
  if (['mqtt', 'providers'].includes(status?.input)) {
    reloadable.push('Provider connections, location, sensor topics and polling intervals',
      'H66 device selection and verification file');
  }
  const restartRequired = [
    'Input mode',
    'Web address, port and access token',
    'Data and database locations',
    'Environment variables, including overrides',
  ];
  const message = reload?.unavailable === true
    ? reload.reason || 'Settings recovery failed. Restart the application.'
    : reload?.busy === true
      ? 'The application is starting or updating settings. Try again shortly.'
      : !supported
        ? reload?.reason || 'Settings reload is not available for this instance.'
        : 'Reads the saved options file and reconnects providers. Startup environment overrides still apply. Finish heating tests or setting changes first; any pending heating restoration must complete. Changes to input, web access or storage settings block the whole reload.';
  return { available, message, reloadable, restartRequired };
}
