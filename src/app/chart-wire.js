import { createHash } from 'node:crypto';

/** Prepare once on the history worker. Timing/cache diagnostics and the moving
 * display clock cannot turn unchanged chart geometry into a different revision.
 * Comparison summaries have their own UI and are outside the drawing revision. */
export function prepareChartResponse(result) {
  const { now, meta, timingBenefit, heatingBenefit, heatingSavings, firewoodBenefit, ...content } = result;
  const { elapsedMs, cacheHit, contentRevision, ...meaning } = meta;
  const drawing = JSON.stringify(content);
  const summaries = JSON.stringify({ timingBenefit, heatingBenefit, heatingSavings, firewoodBenefit });
  const body = summaries.length > 2 ? drawing.slice(0, -1) + ',' + summaries.slice(1) : drawing;
  const metadata = JSON.stringify(meaning);
  const revision = createHash('sha256').update(drawing).update(metadata).digest('hex');
  result.meta.contentRevision = revision;
  return { body, metadata, revision, bytes: Buffer.byteLength(body) + Buffer.byteLength(metadata) };
}

export function encodeChartResponse(result, prepared, format = 'json') {
  // Splice only the known outer object delimiters. Source strings remain encoded
  // by JSON.stringify; the HTTP thread never clones/stringifies chart objects.
  const json = prepared.body.slice(0, -1) + ',"now":' + JSON.stringify(result.now)
    + ',"meta":' + prepared.metadata.slice(0, -1) + (prepared.metadata.length > 2 ? ',' : '') + '"elapsedMs":' + JSON.stringify(result.meta.elapsedMs ?? null)
    + (result.meta.cacheHit ? ',"cacheHit":true' : '') + ',"contentRevision":' + JSON.stringify(prepared.revision) + '}}';
  const text = format === 'ndjson' ? '{"type":"result","data":' + json + '}\n' : json;
  // allocUnsafeSlow owns its buffer, unlike small pooled Buffers. Transfer it
  // without detaching any cached data or copying megabytes on the HTTP thread.
  const bytes = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  bytes.write(text);
  return bytes;
}
