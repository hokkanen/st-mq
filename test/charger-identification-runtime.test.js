import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { teslamateConfiguration } from '../src/app/config.js';
test('Easee exposes schedule control without the retired current-modulation experiment',async()=>{
  const providers=createDeviceProviders({connections:{easee:{}},http:{json:async()=>({})}});
  assert.equal(providers.chargerIdentificationControl,undefined);assert.equal(typeof providers.chargerScheduleControl,'function');await providers.close();
});
test('old automatic-assignment and identification switches fail closed at configuration boundary',()=>{
  for(const settings of [{chargerAssignment:'auto'},{chargerIdentification:true},{charger_identification:true}])assert.throws(()=>teslamateConfiguration(settings));
});
