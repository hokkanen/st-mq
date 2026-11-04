/** Installation estimates are configuration, never observations or passed trials. */
import defaultConfiguration from '../../config.json' with {type:'json'};
const sharedDefaultModel=Object.freeze({...defaultConfiguration.options.controller.home_model});

const RULES = Object.freeze({
  loss_per_hour: ['lossPerHour', .001, .12],
  hydronic_c_per_kwh: ['hydronicCPerKwh', .005, .6],
  solar_c_per_hour_per_kwm2: ['solarCPerHourPerKwM2', 0, 2.5],
  memory_exchange_per_hour: ['memoryExchangePerHour', .005, .4],
  reserve_time_hours: ['reserveTimeHours', 2, 72],
  internal_c_per_hour: ['internalCPerHour', 0, .5],
  duty_per_degree: ['dutyPerDegree', 0, .15],
  balance_temperature_c: ['balanceTemperatureC', 5, 25],
  reduction_ratio: ['reductionRatio', 0, 1],
  preheat_ratio: ['preheatRatio', 0, 2],
  trajectory_error_c: ['trajectoryErrorC', .1, 2],
  training_samples: ['trainingSamples', 1, 10_000_000],
});
const MODEL_RULES=new Map(Object.values(RULES).map(([key,min,max])=>[key,{min,max}]));
const MODEL_BASES=new Set(['historically-trained-initial-estimate','calibrated-initial-estimate','engineering-initial-estimate']);
const validTrainingTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
  &&new Date(value).toISOString()===value;

/** Validate optional persisted initial estimates without resolving or rewriting them. */
export function validHomeModelEstimate(input) {
  if(input==null)return true;
  if(typeof input!=='object'||Array.isArray(input))return false;
  for(const [key,value]of Object.entries(input)){
    const rule=MODEL_RULES.get(key);
    if(rule){if(!Number.isFinite(value)||value<rule.min||value>rule.max
      ||key==='trainingSamples'&&!Number.isSafeInteger(value))return false;}
    else if(key==='calibrationId'){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value))return false;}
    else if(key==='trainingDigest'){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))return false;}
    else if(key==='trainingThrough'){if(!validTrainingTime(value))return false;}
    else if(key==='basis'){if(!MODEL_BASES.has(value))return false;}
    else return false;
  }
  return Boolean(input.trainingDigest)===Boolean(input.trainingSamples);
}

export function homeModelConfiguration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Initial Home model must be an object.');
  const result = {};
  for (const [key, value] of Object.entries({...sharedDefaultModel,...input})) {
    if(key==='training_through'){
      if(!validTrainingTime(value))throw new Error('Invalid Home model training cutoff.');
      result.trainingThrough=value;continue;
    }
    if(key==='calibration_id'){
      if(typeof value!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value))throw new Error('Invalid Home model calibration identifier.');
      result.calibrationId=value;continue;
    }
    if (key === 'training_sha256') {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid Home model training digest.');
      result.trainingDigest = value;
      continue;
    }
    const rule = Object.hasOwn(RULES,key) ? RULES[key] : null;
    if (!rule || !Number.isFinite(value) || value < rule[1] || value > rule[2]
      || key === 'training_samples' && !Number.isSafeInteger(value)) throw new Error('Invalid initial Home model setting.');
    result[rule[0]] = value;
  }
  if (Boolean(result.trainingDigest) !== Boolean(result.trainingSamples)) throw new Error('Home model training provenance requires a digest and sample count.');
  return result;
}

export const DEFAULT_HOME_MODEL=Object.freeze(homeModelConfiguration());
export const DEFAULT_HOME_ENERGY=Object.freeze({
  compressorKw:defaultConfiguration.options.controller.heat_pump_compressor_kw,
  auxiliaryKw:defaultConfiguration.options.controller.auxiliary_rated_kw,
  circulationKw:defaultConfiguration.options.controller.circulation_kw,
  dhwrKw:defaultConfiguration.options.controller.dhwr_kw,
});

/** A steady-state starting hypothesis; the unmeasured reserve retains uncertainty. */
export function initialHomeState(model, indoorC, outdoorC, solarRadiationWm2 = 0) {
  const p = model.parameters;
  const solar = Number.isFinite(solarRadiationWm2) ? Math.max(0, solarRadiationWm2) / 1000 : 0;
  const loss = p.lossPerHour * (indoorC - (Number.isFinite(outdoorC) ? outdoorC : indoorC));
  const gain = (model.initialModel?.internalCPerHour ?? 0) + p.solarCPerHourPerKwM2 * solar;
  const reserveC = indoorC + Math.max(-2, Math.min(8, (loss - gain) / p.memoryExchangePerHour));
  return { indoorC, reserveC, slabC: model.floor?.enabled ? indoorC : null };
}

export function initialActionResponse(model, phase) {
  if (phase === 'reduction') return model.initialModel?.reductionRatio ?? .25;
  if (phase === 'preheat') return model.initialModel?.preheatRatio ?? 1;
  return 1;
}

/** Fresh room evidence with retained latent estimates or explicit initial priors. */
export function homePlanningState(model,indoorC,outdoorC,solarRadiationWm2,state) {
  const initial=initialHomeState(model,indoorC,outdoorC,solarRadiationWm2);
  return {...initial,reserveC:state?.reserveC??initial.reserveC,slabC:state?.slabC??initial.slabC};
}
