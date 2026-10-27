import test from 'node:test';import assert from 'node:assert/strict';
import {bindEmailEvidenceProtocol} from './operator-email-repair.mjs';
test('verification is single-use and only its exact evidence identity can revalidate or create a grant',async()=>{
 const evidence={acceptance:{id:'actual'}},snapshot={id:'actual'},calls=[];
 const p=bindEmailEvidenceProtocol(async options=>{calls.push(options);return {evidence,snapshot,revalidate:async()=>calls.push('revalidated')};},options=>{calls.push(options);return 'grant';});
 assert.equal(p.kind,'email-test-contract-repair/v1');assert.throws(()=>p.createGrant({evidence}));
 assert.equal(await p.verify({candidatePath:'frozen'}),evidence);await assert.rejects(p.verify({}));await p.revalidate(evidence);
 await assert.rejects(p.revalidate({...evidence}));assert.throws(()=>p.createGrant({evidence:{...evidence}}));
 assert.equal(p.createGrant({evidence,baselineBuildId:'baseline',environmentSha256:'private-hash'}),'grant');assert.equal(calls.at(-1).snapshot,snapshot);assert.equal(calls.at(-1).acceptance,evidence.acceptance);
});
