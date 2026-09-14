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
  if (learning?.reconstruction === 'snapshot' && status !== 'unavailable') {
    status = 'snapshot'; title = 'Recorded primary model';
    summary = 'Saved model and evidence from the primary snapshot. Live action readiness and cycle assessments are unavailable here.';
  }
  return { status, title, summary, usableSamples, acceptedFits };
}

/** Garage qualifies complete cooling/recovery episodes and their OFF duration.
 * A large count of short-step checks cannot establish a multi-hour forecast. */
export function garageLearningOverview(learning = {}) {
  const trainedIntervals = count(learning?.trainedIntervals);
  const completedEpisodes = count(learning?.validation?.completedEpisodes);
  const thermalReady = learning?.thermalReady === true;
  const reportedHours = learning?.maxPauseHours;
  const validatedPauseHours = Number.isFinite(reportedHours) && reportedHours >= 0
    ? thermalReady ? reportedHours : learning?.thermalReady === false ? 0 : null : null;
  let status = 'unavailable', title = 'Awaiting model status', summary = 'Learning status is not available yet.';
  if (learning?.reconstruction === 'failed') {
    status = 'attention'; title = 'Rebuild needs attention';
    summary = 'The model could not finish updating from recorded observations.';
  } else if (learning?.reconstruction === 'rebuilding') {
    status = 'rebuilding'; title = 'Rebuilding model';
    summary = 'Updating the garage model from recorded observations.';
  } else if (thermalReady && validatedPauseHours > 0) {
    status = 'provisional'; title = 'Temperature model validated';
    const duration = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(validatedPauseHours);
    summary = `Temperature checks support pauses up to ${duration} h. ` + (learning?.electricalReady === true
      ? 'Electricity and recovery-energy checks have also passed. Savings remain estimates.'
      : learning?.electricalReady === false
        ? 'Electricity and recovery-energy predictions still need validation.'
        : 'Electricity and recovery-energy validation is not reported yet.');
  } else if (learning?.status === 'learning' || learning?.status === 'validated-provisional') {
    status = trainedIntervals === 0 ? 'initial' : 'learning';
    title = trainedIntervals === 0 ? 'Initial estimates' : 'Learning from observations';
    summary = trainedIntervals === 0
      ? 'The garage model is collecting evidence before refining its starting estimates.'
      : 'Complete cooling and recovery episodes establish how long a pause can be predicted. Electricity is validated separately.';
  }
  if (learning?.reconstruction === 'snapshot' && status !== 'unavailable') {
    status = 'snapshot'; title = 'Recorded primary model';
    summary = 'Saved temperature and electricity evidence from the primary snapshot. Live pause eligibility is unavailable here.';
  }
  return { status, title, summary, completedEpisodes, validatedPauseHours };
}

const isFilePath = path => typeof path === 'string' && path.startsWith('/') && path.length > 1 && !path.endsWith('/');
function configurationLocation(configuration) {
  const addon = configuration?.environment === 'home-assistant';
  const ubuntu = configuration?.environment === 'ubuntu';
  const path = addon ? configuration.externalImportPath : ubuntu ? configuration.privatePath : null;
  const rows = [];
  if (isFilePath(path)) {
    const separator = path.lastIndexOf('/');
    rows.push({ label: 'Folder', value: path.slice(0, separator) || '/' },
      { label: 'File name', value: path.slice(separator + 1) }, { label: 'Full path', value: path });
  }
  if (addon && isFilePath(configuration.importPath)) rows.push({ label: 'Inside add-on', value: configuration.importPath });
  return { title: addon ? 'Host dashboard · upload location' : ubuntu ? 'Ubuntu · permanent configuration file' : 'Configuration file location',
    rows, message: isFilePath(path) ? '' : 'Restart ST-MQ to load configuration paths, then refresh this page' };
}

/** Only the API can declare a configuration source available. Instructions use
 * its actual paths, so service accounts and HA repository slugs stay accurate. */
export function settingsReloadScope(status = {}) {
  const reload = status?.settingsReload;
  const supported = reload?.available === true && reload?.unavailable !== true;
  const available = supported && reload?.busy !== true;
  const reloadable = [
    'Price-control mode, comfort limits and learning settings',
    'Electricity rates',
    'Recording interval and storage budget',
    'Access token and direct-access availability',
  ];
  if (['mqtt', 'providers'].includes(status?.input)) {
    reloadable.push('Provider connections, location, sensor topics and polling intervals',
      'H66 device selection and verification file');
  }
  const restartRequired = [
    'Input mode',
    'Web address and port',
    'Data and database locations',
    'Environment variables, including overrides',
  ];
  const message = reload?.unavailable === true
    ? reload.reason || 'Settings recovery failed. Restart the application.'
    : reload?.busy === true
      ? 'The application is starting or updating settings. Try again shortly.'
      : !supported
        ? reload?.reason || 'Applying configuration is not available for this instance.'
        : 'Startup environment overrides still apply. Finish heating tests or setting changes first; any pending heating restoration must complete. Changes to input mode, web address or port, or storage locations require restart and block the whole application of settings.';
  const configuration = reload?.configuration;
  const location = configurationLocation(configuration);
  const instructions = [], access = [];
  if (configuration?.environment === 'home-assistant') {
    instructions.push('Change and save options in the host dashboard. Apply configuration reads those freshly saved options.');
    if (isFilePath(configuration.externalImportPath)) instructions.push(`To import settings, upload the file to ${configuration.externalImportPath} using SSH.`);
    instructions.push('Use a plain JSON options object without an outer options wrapper. Omitted fields keep saved values, arrays replace saved arrays, and explicit empty values clear fields.');
    instructions.push('Choose Apply configuration. A successful import saves its values in the host dashboard and removes the uploaded file; a failed import keeps the file for correction.');
    if (reload.access?.ingress?.enabled === true) access.push('Host dashboard access is enabled and uses your host login.');
    if (reload.access?.direct?.enabled === false) access.push('Direct access is disabled. Set controller.web_token to at least 24 characters and apply to enable it.');
    else if (reload.access?.direct?.enabled === true) access.push('Direct access is enabled and requires your access token. Clear controller.web_token and apply to disable it.');
  } else if (configuration?.environment === 'ubuntu') {
    if (isFilePath(configuration.privatePath)) instructions.push(`Edit the permanent private JSON file at ${configuration.privatePath}.`
      + (isFilePath(configuration.defaultsPath) ? ` It overrides the options defaults in ${configuration.defaultsPath}.` : ''));
    instructions.push('Use a plain JSON options object without an outer options wrapper. Include the settings you want to override; omitted settings use the defaults.');
    instructions.push('Save the file, then choose Apply configuration. The private file stays in place for future starts and changes.');
    if (reload.access?.direct?.enabled === true) access.push(reload.access.direct.tokenRequired
      ? 'Direct access is enabled and requires your access token.'
      : 'Local access is enabled. Loopback access works without a token.');
  }
  return { available, message, reloadable, restartRequired, instructions, access, location };
}
