/** Read after previously accepted acquisition and an explicit controller update
 * have committed. Waiting here keeps assertions independent of event-loop and
 * SQLite admission timing without manufacturing another observation. */
export async function committedStatus(engine) {
  await committedWrites(engine.store);
  await engine.update();
  return engine.store.runWrite(() => engine.status());
}

export async function committedWrites(store) {
  // A FIFO barrier commits after earlier observation callbacks and their queued
  // persistence work. The callback does not acknowledge a device or add data.
  await store.runWrite(() => {});
}
