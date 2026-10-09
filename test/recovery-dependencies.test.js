import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { validateRecoveryDependencies } from '../src/recovery/dependencies.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';

const at=Date.parse('2026-01-01T00:00:00Z');
test('cycle upserts deduplicate repeated source references before the outer conflict policy',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const id=store.observation({source:'synthetic',device:'synthetic-room',signal:'indoor_temperature',unit:'degC',value:21,sourceTime:at,receivedAt:at});
  const cycle={id:'synthetic-cycle',status:'active',startedAt:at,observations:[{provenance:{observationId:id,lineage:{indoor:{observations:[id,id]}}}}]};
  store.cycle('mqtt',cycle);
  store.cycle('mqtt',{...cycle,observations:[...cycle.observations,...cycle.observations],endedAt:at+1000,status:'completed'});
  const references=store.db.prepare('SELECT source_table,source_key FROM recovery_dependencies WHERE owner_table=? AND owner_key=?').all('learning_cycles',cycle.id);
  assert.deepEqual(references.map(row=>({...row})),[{source_table:'observations',source_key:String(id)}]);
  const before=store.checkpoint();
  assert.throws(()=>store.transaction(()=>{store.cycle('mqtt',{...cycle,observations:[]});throw Error('synthetic rollback');}),/synthetic rollback/);
  assert.deepEqual(store.checkpoint(),before);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recovery_dependencies').get().n,1);
  store.cycle('mqtt',{...cycle,observations:[]});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recovery_dependencies').get().n,0);
});

test('dependency verification requires exact root/cycle references and handles current projection remapping', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const payload = { value: { id: 'synthetic-cycle', provenance: { observationId: 7,
    coverage: [8, 8], forecastVersion: { id: 9 }, journal: [1] } } };
  const root = store.appendLearningJournal('mqtt', { kind: 'episode', at, algorithmVersion: LEARNING_ALGORITHM,
    payload, key: 'synthetic-root' });
  const expected = [
    ['learning_cycles', 'synthetic-cycle'], ['learning_journal', String(root)],
    ['observations', '7'], ['provider_snapshot_fetches', '9'], ['recorder_coverage', '8'],
  ];
  assert.deepEqual(store.db.prepare(`SELECT source_table,source_key FROM recovery_dependencies
    WHERE owner_table='learning_journal' AND owner_key=? ORDER BY source_table,source_key`).all(String(root))
    .map(row => [row.source_table, row.source_key]), expected);
  const projection = Number(store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,payload,source_entry_id) VALUES(?,?,?,?,?,?,?,?)`)
    .run('synthetic-projection', 'mqtt', 'projection', 'episode', at, LEARNING_ALGORITHM, JSON.stringify(payload), root).lastInsertRowid);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recovery_dependencies WHERE owner_key=?').get(String(projection)).n, 0);
  assert.doesNotThrow(() => validateRecoveryDependencies(store.db));
  store.db.prepare('UPDATE learning_journal_entries SET payload=? WHERE id=?').run(JSON.stringify(payload), projection);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recovery_dependencies WHERE owner_key=?').get(String(projection)).n, expected.length);
  assert.doesNotThrow(() => validateRecoveryDependencies(store.db));
  store.db.prepare("DELETE FROM recovery_dependencies WHERE owner_table='learning_journal' AND owner_key=? AND source_table='observations'").run(String(root));
  assert.throws(() => validateRecoveryDependencies(store.db), { code: 'database_integrity_failed' });
});

for (const owner of ['unknown', 'missing-cycle', 'noncanonical-root', 'unbacked-projection']) {
  test(`dependency verification rejects ${owner} edges without repairing the index`, t => {
    const store = new Store(':memory:'); t.after(() => store.close());
    const root = store.appendLearningJournal('mqtt', { kind: 'context', at, algorithmVersion: LEARNING_ALGORITHM,
      payload: { value: {} }, key: 'synthetic-context' });
    const projection = Number(store.db.prepare(`INSERT INTO learning_journal_entries
      (epoch,input,key,kind,at,algorithm_version,source_entry_id) VALUES(?,?,?,?,?,?,?)`)
      .run('synthetic-projection', 'mqtt', 'projection', 'context', at, LEARNING_ALGORITHM, root).lastInsertRowid);
    const table = owner === 'unknown' ? 'unsupported' : owner === 'missing-cycle' ? 'learning_cycles' : 'learning_journal';
    const key = owner === 'noncanonical-root' ? `0${root}` : owner === 'unbacked-projection' ? String(projection) : 'missing';
    store.db.prepare('INSERT INTO recovery_dependencies VALUES(?,?,?,?)').run(table, key, 'observations', '123');
    const before = store.db.prepare('SELECT * FROM recovery_dependencies').all(), checkpoint = store.checkpoint();
    assert.throws(() => validateRecoveryDependencies(store.db), { code: 'database_integrity_failed' });
    assert.deepEqual(store.db.prepare('SELECT * FROM recovery_dependencies').all(), before);
    assert.deepEqual(store.checkpoint(), checkpoint);
  });
}
