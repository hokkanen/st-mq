const sensorPattern = /^sensor\.[a-z0-9_]+$/;
const sourceClock = (name, entity) => `{% set ${name}_time = as_datetime(state_attr('${entity}', 'timestamp'), none) %}
{% set ${name}_at = ${name}_time.isoformat() if ${name}_time is not none and ${name}_time.tzinfo is not none else none %}`;

function booleanFact(name, entity, onValues, offValues) {
  return `${sourceClock(name, entity)}
{% set ${name}_state = states('${entity}')|upper %}
{% set ${name}_value = true if ${name}_state in ${JSON.stringify(onValues)} else false if ${name}_state in ${JSON.stringify(offValues)} else none %}
{% set ${name}_value = ${name}_value if ${name}_at is not none else none %}
{% set ns.data = dict(ns.data, ${name}=${name}_value) %}
{% set ns.fields = dict(ns.fields, ${name}=dict(measuredAt=${name}_at,
  readingId='bmw:${name}:' ~ (${name}_at or 'unknown') ~ ':' ~ (${name}_value|to_json))) %}`;
}

/** Home Assistant automation for measured BMW CarData inputs.
 * Entity identifiers and the optional home point are supplied privately at deployment.
 * MQTT contains no coordinates, tracker identifiers, or private zone names.
 */
export function bmwCardataAutomation({ socEntity, targetEntity, capacityEntity,
  plugEntity, chargingEntity, locationEntity, latitudeEntity, longitudeEntity,
  homeLatitude, homeLongitude, homeRadiusMeters, topic = 'stmq/vehicles/bmw' }) {
  const batteryEntities = [socEntity, targetEntity, capacityEntity];
  if (batteryEntities.some(value => typeof value !== 'string' || !sensorPattern.test(value)))
    throw new Error('Three CarData sensor entity IDs are required');
  for (const value of [plugEntity, chargingEntity, latitudeEntity, longitudeEntity]) {
    if (value !== undefined && (typeof value !== 'string' || !sensorPattern.test(value)))
      throw new Error('Optional CarData inputs must be sensor entity IDs');
  }
  if (locationEntity !== undefined && (typeof locationEntity !== 'string' || !/^device_tracker\.[a-z0-9_]+$/.test(locationEntity)))
    throw new Error('The CarData location input must be a device_tracker entity ID');
  if (Boolean(latitudeEntity) !== Boolean(longitudeEntity)) throw new Error('Both coordinate sensor entity IDs are required');
  const explicitHome = homeLatitude !== undefined || homeLongitude !== undefined;
  if (explicitHome && (!Number.isFinite(homeLatitude) || Math.abs(homeLatitude) > 90
    || !Number.isFinite(homeLongitude) || Math.abs(homeLongitude) > 180))
    throw new Error('A valid home latitude and longitude must be supplied together');
  if (homeRadiusMeters !== undefined && (!Number.isFinite(homeRadiusMeters) || homeRadiusMeters < 1 || homeRadiusMeters > 10_000))
    throw new Error('The home radius must be between 1 and 10000 metres');
  if (typeof topic !== 'string' || !topic || /[+#\u0000-\u001f]/.test(topic)) throw new Error('A concrete MQTT topic is required');
  const entities = [...new Set([...batteryEntities, plugEntity, chargingEntity, locationEntity,
    latitudeEntity, longitudeEntity, ...(!explicitHome && latitudeEntity ? ['zone.home'] : [])].filter(Boolean))];
  const templates = [`{% set soc = states('${socEntity}') %}
{% set target = states('${targetEntity}') %}
{% set capacity = states('${capacityEntity}') %}
${sourceClock('soc', socEntity)}
${sourceClock('target', targetEntity)}
${sourceClock('capacity', capacityEntity)}
{% set ns = namespace(data=dict(provider='bmw-cardata'), fields=dict()) %}
{% if is_number(soc) and 0 <= soc|float <= 100 and soc_at is not none %}
  {% set ns.data = dict(ns.data, soc=soc|float, measuredAt=soc_at, readingId='bmw:soc:' ~ soc_at ~ ':' ~ soc) %}
{% endif %}
{% if is_number(target) and 0 <= target|float <= 100 and target_at is not none %}
  {% set ns.data = dict(ns.data, chargeLimitSoc=target|float) %}
  {% set ns.fields = dict(ns.fields, chargeLimitSoc=dict(measuredAt=target_at,
    readingId='bmw:target:' ~ target_at ~ ':' ~ target)) %}
{% endif %}
{% if is_number(capacity) and 1 <= capacity|float <= 300 and capacity_at is not none %}
  {% set ns.data = dict(ns.data, usableCapacityKwh=capacity|float) %}
  {% set ns.fields = dict(ns.fields, usableCapacityKwh=dict(measuredAt=capacity_at,
    readingId='bmw:capacity:' ~ capacity_at ~ ':' ~ capacity)) %}
{% endif %}`];
  if (plugEntity) templates.push(booleanFact('pluggedIn', plugEntity, ['CONNECTED'], ['DISCONNECTED']));
  // BMW's documented charging.status values: initialization is not charging;
  // error/unknown states are deliberately not reported as a confirmed false.
  if (chargingEntity) templates.push(booleanFact('charging', chargingEntity,
    ['CHARGINGACTIVE', 'CHARGING_ACTIVE', 'CHARGING', 'CHARGING_IN_PROGRESS'],
    ['NOCHARGING', 'INITIALIZATION', 'CHARGINGPAUSED', 'CHARGINGENDED']));
  if (latitudeEntity) {
    // CarData 5.2.8's tracker restores coordinates and hides BMW source clocks.
    // Its raw coordinate sensors expose timestamp attributes. Never substitute
    // tracker last_changed/last_updated or automation time for those clocks.
    const homeLat = explicitHome ? homeLatitude : "state_attr('zone.home', 'latitude')";
    const homeLon = explicitHome ? homeLongitude : "state_attr('zone.home', 'longitude')";
    const homeRadius = homeRadiusMeters ?? (explicitHome ? 100 : "state_attr('zone.home', 'radius')");
    templates.push(`${sourceClock('latitude', latitudeEntity)}
${sourceClock('longitude', longitudeEntity)}
{% set latitude = states('${latitudeEntity}') %}
{% set longitude = states('${longitudeEntity}') %}
{% set home_latitude = ${homeLat} %}
{% set home_longitude = ${homeLon} %}
{% set home_radius = ${homeRadius} %}
{% set atHome_value = none %}
{% set atHome_at = none %}
{% if latitude_at is not none and longitude_at is not none
  and (as_timestamp(latitude_time) - as_timestamp(longitude_time))|abs <= 60
  and is_number(latitude) and -90 <= latitude|float <= 90
  and is_number(longitude) and -180 <= longitude|float <= 180
  and (latitude|float != 0 or longitude|float != 0)
  and is_number(home_latitude) and -90 <= home_latitude|float <= 90
  and is_number(home_longitude) and -180 <= home_longitude|float <= 180
  and is_number(home_radius) and 1 <= home_radius|float <= 10000 %}
  {% set lat_delta = (latitude|float - home_latitude|float) * 0.017453292519943295 %}
  {% set lon_delta = (longitude|float - home_longitude|float) * 0.017453292519943295 %}
  {% set haversine = ((lat_delta / 2)|sin)**2 + ((home_latitude|float * 0.017453292519943295)|cos)
    * ((latitude|float * 0.017453292519943295)|cos) * ((lon_delta / 2)|sin)**2 %}
  {% set distance = 12742000 * ((([1, [0, haversine]|max]|min)|sqrt)|asin) %}
  {% set atHome_value = distance <= home_radius|float %}
  {% set atHome_at = latitude_at if latitude_time <= longitude_time else longitude_at %}
{% endif %}
{% set ns.data = dict(ns.data, atHome=atHome_value) %}
{% set ns.fields = dict(ns.fields, atHome=dict(measuredAt=atHome_at,
  readingId='bmw:atHome:' ~ ((latitude_at ~ ':' ~ longitude_at) if atHome_at is not none else 'unknown') ~ ':' ~ (atHome_value|to_json))) %}`);
  } else if (locationEntity) {
    // A restored tracker alone is insufficient evidence. Explicit null clears
    // a previously published home fact until timestamped coordinates arrive.
    templates.push(`{% set ns.data = dict(ns.data, atHome=none) %}
{% set ns.fields = dict(ns.fields, atHome=dict(measuredAt=none, readingId='bmw:atHome:unknown:null')) %}`);
  }
  templates.push('{{ dict(ns.data, fields=ns.fields)|to_json }}');
  return {
    alias: 'STMQ BMW CarData to MQTT',
    description: 'Measured battery, plug, charging and home facts with independent BMW source clocks. No location coordinates are published.',
    mode: 'restart',
    triggers: [
      { trigger: 'state', entity_id: entities },
      { trigger: 'homeassistant', event: 'start' },
      { trigger: 'mqtt', topic: 'homeassistant/status', payload: 'online' },
      { trigger: 'time_pattern', minutes: '/5' },
    ],
    conditions: [],
    actions: [{ action: 'mqtt.publish', data: { topic, qos: 1, retain: true, payload: templates.join('\n') } }],
  };
}
