import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {proveBonusAlphaHold,reconstructBonusNodePin,BONUS_HELD_ALPHA} from './bonus-alpha-hold.mjs';
const repository=fileURLToPath(new URL('../..',import.meta.url)),original='dc74b804fcecb4bab3207e82c9b9f099b9bf13be';
test('reconstructs the actual immutable CI-only merge while preserving the original build controller',()=>{
 const proof=proveBonusAlphaHold({repository,observedHead:BONUS_HELD_ALPHA});assert.equal(proof.originalBuildController,original);assert.equal(proof.heldCanonicalHead,BONUS_HELD_ALPHA);assert.equal(proof.pins.length,3);assert.equal(proof.applicationAndMigrationGitInputsUnchanged,true);assert.equal(proof.originalBuildControllerPreserved,true);assert.equal(proof.releaseAuthorized,false);assert.equal(proof.fullGatePassCreated,false);
 assert.deepEqual(proof,proveBonusAlphaHold({repository,observedHead:BONUS_HELD_ALPHA}));
});
for(const head of [original,'0'.repeat(40),'main',undefined])test('refuses another observed canonical head '+String(head),()=>assert.throws(()=>proveBonusAlphaHold({repository,observedHead:head})));
test('exact source reconstruction refuses missing or duplicated pin locations and unrelated paths',()=>{
 const path='.github/workflows/alpha-staging.yml',one="with: {node-version: '22'}\n";
 assert.equal(reconstructBonusNodePin(path,one+one),one.replace("'22'","'22.23.3'").repeat(2));
 for(const text of ['',one,one.repeat(3),"node-version: '22.23.4'"])assert.throws(()=>reconstructBonusNodePin(path,text));
 assert.throws(()=>reconstructBonusNodePin('app/page.tsx',one+one));assert.throws(()=>reconstructBonusNodePin(path,'x'.repeat(128*1024+1)));
});
test('action description and default must both be the exact original single declarations',()=>{
 const path='.github/actions/setup-alpha/action.yml',before="description: Node major\n  default: '22'\n";
 assert.equal(reconstructBonusNodePin(path,before),"description: Exact Node version (fingerprints bind it)\n  default: '22.23.3'\n");
 for(const text of [before.replace('Node major','Unrelated'),before.replace("default: '22'","default: '22.23.4'"),before+before])assert.throws(()=>reconstructBonusNodePin(path,text));
});
