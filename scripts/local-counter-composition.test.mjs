import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewComposedControllers,COUNTER_EXCEPTION as P} from './local-counter-exception.mjs';
import {collectCounterException} from './local-counter-exception-evidence.mjs';
import {counterExceptionFlow} from './local-counter-exception-operator.mjs';
import {ACCEPTANCE_TIER} from './local-counter-exception-acceptance.mjs';
const db=Array.from({length:981},(_,i)=>`test/db${String(i).padStart(4,'0')}.test.ts`),nodb=Array.from({length:963},(_,i)=>`test/no${String(i).padStart(4,'0')}.test.ts`),inventory={db,nodb,all:[...db,...nodb].sort()};
const start=`head: ${P.candidate.slice(0,9)}\n▸ test lock: both slots held\n`;
const section=count=>` ASKED FOR ${count} FILES, VITEST COUNTED NOTHING\n exit=1 peak-disk=31% wall=300s (rebuild+migrate+vitest)\n`;
const heading=i=>`════ part (b) chunk ${i}/16 — ${db.filter((_,n)=>n%16===i-1).length} DB files ════\n`;
const prefix=start+'════ part (a) — 963 no-DB files, one run, 2 workers, no cluster, DB URLs on a closed port ════\n'+section(963)+Array.from({length:8},(_,i)=>heading(i+1)+section(db.filter((_,n)=>n%16===i).length)).join('')+heading(9);
const resume=start+'▸ PARTIAL RUN — chunks 9..16 of 16 only\n'+Array.from({length:8},(_,i)=>heading(i+9)+section(61)).join('')+'════ FINAL ════\n'+Array.from({length:8},(_,i)=>` chunk ${i+9}: exit=1 <no summary>\n`).join('')+' runs: 8 files counted: 0 of 1944 in the suite (963 no-DB + 981 DB)\n GATE RED — read the logs\n receipt: none written (a slice or a proof run is not a gate)\n';
test('exact cancelled prefix plus complete remaining slice preserves incomplete/unknown truth',()=>{
 const value=reviewComposedControllers(prefix,resume,inventory);
 assert.equal(value.canonicalResult,'INCOMPLETE_CANCELLED');assert.equal(value.phases,17);assert.equal(value.partialOriginalBatch9Excluded,true);assert.equal(value.releaseAuthorized,false);assert.equal(value.rawVitestExit,'UNKNOWN_NOT_SEPARATELY_RECORDED');
});
test('composition rejects gaps, duplicates, partial completion and fabricated source/count/receipt',()=>{
 for(const [a,b] of [[prefix.replace('chunk 8/16','chunk 7/16'),resume],[prefix+section(61),resume],[prefix+'════ FINAL ════\n',resume],[prefix,resume.replace('chunk 16/16','chunk 15/16')],[prefix,resume.replace('════ FINAL ════','')],[prefix,resume+'GATE GREEN\n'],[prefix,resume.replace('receipt: none written (a slice or a proof run is not a gate)','receipt: .gate-receipt.json result=PASS')],[prefix,resume.replace('exit=1 peak','exit=0 peak')],[prefix,resume.replace('files counted: 0','files counted: 488')],[prefix,resume.replace('chunks 9..16','chunks 8..16')],[prefix,resume.replace(P.candidate.slice(0,9),'f'.repeat(9))]])assert.throws(()=>reviewComposedControllers(a,b,inventory));
 assert.throws(()=>reviewComposedControllers(prefix,resume,{...inventory,db:db.slice(1)}));
});
test('cancelled collector refuses absent recovery retry and active remaining slice before Git/source reads',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'aihr-compose-'))),candidate=join(base,'candidate'),run=join(candidate,'scratchpad',P.run),rest=join(candidate,'scratchpad',P.resume);
 mkdirSync(run,{recursive:true});mkdirSync(rest,{recursive:true});
 const write=(root,name,value)=>writeFileSync(join(root,name),JSON.stringify(value));
 try {
  write(run,'cleanup.json',{gateExit:-15,interrupted:15,sharedRestoredAndContentsVerified:false,privateDirectoryRemoved:false,errors:["pg_ctl 'stop' failed"]});
  await assert.rejects(collectCounterException({candidatePath:candidate,runDirectory:run}),/recovery-followup/);
  write(run,'recovery-followup.json',{passed:true,originalCleanupFailureRetained:true,pinnedRecoveryExit:0,sharedRestoredAndContentsVerified:true,privateDirectoryRemoved:true});
  write(run,'failure.json',{source:P.candidate,gateExit:-15,interrupted:15});
  await assert.rejects(collectCounterException({candidatePath:candidate,runDirectory:run}),/cleanup.json/);
  write(rest,'cleanup.json',{gateExit:1,interrupted:0,sharedRestoredAndContentsVerified:false,privateDirectoryRemoved:false,errors:[]});
  await assert.rejects(collectCounterException({candidatePath:candidate,runDirectory:run}),/remaining slice active/);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('operator refuses an unvalidated cancelled composition before transport',()=>{
 const evidence={tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',stagingBuildAuthorized:true,canonicalResult:'INCOMPLETE_CANCELLED',originalCandidate:P.candidate,rawVitestExit:'UNKNOWN_NOT_SEPARATELY_RECORDED',sourceBoundary:{counterRepairApplied:true}};
 for(const changes of [{},{composedFromCancelledPrefix:true},{composedFromCancelledPrefix:true,controller:{partialOriginalBatch9Excluded:false}}])assert.throws(()=>counterExceptionFlow({evidence:{...evidence,...changes}}),/unvalidated exception/);
});

test('operator recognizes validated composition without relabelling its original result',()=>{
 const evidence={tier:ACCEPTANCE_TIER,result:'ACCEPTED_WITH_OWNER_EXCEPTION',stagingBuildAuthorized:true,canonicalResult:'INCOMPLETE_CANCELLED',composedFromCancelledPrefix:true,controller:reviewComposedControllers(prefix,resume,inventory),originalCandidate:P.candidate,rawVitestExit:'UNKNOWN_NOT_SEPARATELY_RECORDED',sourceBoundary:{counterRepairApplied:true}};
 assert.throws(()=>counterExceptionFlow({evidence,revalidate:()=>{throw Error('REVALIDATE_REACHED');}}),/REVALIDATE_REACHED/);
 assert.equal(evidence.canonicalResult,'INCOMPLETE_CANCELLED');
});
