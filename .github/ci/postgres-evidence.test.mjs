import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePostgresEvidence,capturePostgresEvidence} from './postgres-evidence.mjs';
import {CI_EXECUTION} from './manifest.mjs';
function evidence(){return {schemaVersion:1,memoryLimit:2147483648,memoryMax:2147483648,memoryPeak:1500000000,memoryEvents:{oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'}};}
test('Measured healthy 2 GiB default-JIT PostgreSQL evidence admits',()=>assert.equal(validatePostgresEvidence(evidence(),CI_EXECUTION),true));
for(const [name,change] of [
 ['missing snapshot',()=>null],['wrong schema',e=>({...e,schemaVersion:99})],
 ['1 GiB Docker cap',e=>({...e,memoryLimit:1073741824})],['wrong cgroup cap',e=>({...e,memoryMax:1073741824})],
 ['missing peak',e=>({...e,memoryPeak:null})],['peak above limit',e=>({...e,memoryPeak:2147483649})],
 ['actual backend OOM kill',e=>({...e,memoryEvents:{oom_kill:1}})],['unknown OOM count',e=>({...e,memoryEvents:{}})],
 ['Docker OOM kill',e=>({...e,state:{...e.state,OOMKilled:true}})],['stopped server',e=>({...e,state:{...e.state,Running:false}})],
 ['dead server',e=>({...e,state:{...e.state,Dead:true}})],['unknown server',e=>({...e,state:null})],
 ['blanket disabled JIT',e=>({...e,settings:{...e.settings,jit:'off'}})],['missing JIT provider',e=>({...e,settings:{...e.settings,jitAvailable:false}})],
 ['wrong PostgreSQL major',e=>({...e,settings:{...e.settings,serverVersionNum:'170005'}})],['unknown settings',e=>({...e,settings:null})],
])test('Resource evidence refuses '+name,()=>assert.throws(()=>validatePostgresEvidence(change(evidence()),CI_EXECUTION)));
test('Unknown execution budget refuses',()=>assert.throws(()=>validatePostgresEvidence(evidence(),null)));
test('Capture refuses outside disposable GitHub CI before accessing Docker',()=>{const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';assert.throws(()=>capturePostgresEvidence('db-'+'a'.repeat(16)));}finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}});
