export function legacyLiveAllowed(env = process.env) {
  return env.STMQ_LEGACY_LIVE === 'I_CONFIRM_LIVE_CONTROL';
}

export function requireLegacyLive(env = process.env) {
  if (!legacyLiveAllowed(env)) {
    throw new Error('Legacy live publishing is disabled. Use npm start for simulation. Legacy operation requires STMQ_LEGACY_LIVE=I_CONFIRM_LIVE_CONTROL after equipment/migration verification.');
  }
}
