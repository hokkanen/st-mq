// Transport belongs to the recorded evidence, never today's connection state.
export function recordedTransport(row = {}) {
  let raw = row.raw, quality = row.quality;
  try { if (typeof raw === 'string') raw = JSON.parse(raw); } catch { raw = null; }
  try { if (typeof quality === 'string') quality = JSON.parse(quality); } catch { quality = null; }
  const explicit = row.transport ?? raw?.transport;
  if (['cloud', 'ocpp'].includes(explicit)) return explicit;
  if (Array.isArray(quality)) {
    const ocpp = quality.includes('local_ocpp'), cloud = quality.includes('easee_cloud');
    if (ocpp !== cloud) return ocpp ? 'ocpp' : 'cloud';
  }
  return null;
}

export function recordingSourceLabel(row = {}) {
  if (row.source !== 'easee') return null;
  const transport = recordedTransport(row);
  return `Easee · ${transport === 'ocpp' ? 'OCPP' : transport === 'cloud' ? 'Cloud' : 'transport unknown'}`;
}
