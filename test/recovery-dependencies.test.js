import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';

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
