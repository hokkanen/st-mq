import { replayLearningJournal } from '../../src/app/committed-learning.js';
import { createCoefficientGeneration,appendCoefficientEvents } from '../../src/storage/coefficient-history.js';
import { emptyCoefficientProjection } from '../../src/domain/coefficient-projection.js';

export function coefficientReplayFixture(store,input,options={}) {
  const events=[];let final;
  const checkpoint=replayLearningJournal(store,input,null,{...options,rebuild:true,persistCheckpoint:false,persistCoefficients:false,
    onCoefficientBatch(batch){events.push(...batch.events);final=batch;}});
  return{checkpoint,events,projection:final?.projection??emptyCoefficientProjection()};
}
/** Direct publication fixtures stage the actual ordered output without selecting
 * the candidate or changing the controlling checkpoint. */
export function coefficientCandidate(store,input,options={}) {
  const value=coefficientReplayFixture(store,input,options);
  const coefficientGeneration=store.transaction(()=>{
    const generation=createCoefficientGeneration(store,input,{epoch:store.learningEpoch(input),
      fireplaceRevision:value.checkpoint?.fireplaceRevision??0,sensorRevision:value.checkpoint?.sensorRevision??0});
    appendCoefficientEvents(store,generation,value);return generation;
  });
  return{checkpoint:value.checkpoint,coefficientGeneration};
}
let sequence=0;
/** The scripted transport follows the same stage/ack protocol as a real worker.
 * Its postMessage handler forwards acknowledgements to coefficient-ack. */
export async function stageScriptedCoefficientCandidate(worker,store,input,request,{generation}={}) {
  const value=coefficientReplayFixture(store,input,{fireplaceRevision:request.revision,sensorRevision:request.sensorRevision});
  const exchange=fields=>new Promise((resolve,reject)=>{
    const requestId=++sequence;
    const accept=message=>{if(message.requestId!==requestId)return;worker.removeListener('coefficient-ack',accept);
      message.error?reject(new Error('Synthetic coefficient staging failed')):resolve(message.generation);};
    worker.on('coefficient-ack',accept);worker.emit('message',{...request,...fields,requestId});
  });
  generation??=await exchange({type:'coefficient-start',prefixCursor:0,projection:emptyCoefficientProjection()});
  await exchange({type:'coefficient-page',coefficientGeneration:generation,events:value.events,projection:value.projection});
  return{checkpoint:value.checkpoint,coefficientGeneration:generation};
}
