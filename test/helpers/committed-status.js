/** Read after previously accepted acquisition and any required status update
 * have committed. Waiting here keeps assertions independent of event-loop and
 * SQLite admission timing without manufacturing another observation. */
export const committedStatus = engine => engine.store.runWrite(() => engine.status());

export async function committedWrites(store) {
  // A FIFO barrier commits after earlier observation callbacks and their queued
  // persistence work. The callback does not acknowledge a device or add data.
  await store.runWrite(() => {});
}
