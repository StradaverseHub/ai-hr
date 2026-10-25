import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCAL_REPAIR as P,digest,chunkMembership,validateOriginalPortAttempt,validateLocalEnvironmentRepair} from './local-environment-repair.mjs';

// Synthetic protocol fixtures exercise refusal behavior, never stand in for release evidence.
const pass=(files,tests)=>` Test Files  ${files} passed (${files})\n Tests  ${tests} passed (${tests})\n Duration  1.2s\n`;
const fail=()=>` FAIL  |node| ${P.test} > ${P.case}\n+ Received:\n\"Error: Actual Reports role/database proof refused.\"\n Test Files  1 failed | 60 passed (61)\n Tests  1 failed | 773 passed (774)\n Duration  1.2s\n`;
function fixture(){
 const db=[...Array.from({length:10},(_,i)=>`test/a-${String(i).padStart(4,'0')}.test.ts`),P.test,...Array.from({length:970},(_,i)=>`test/z-${String(i).padStart(4,'0')}.test.ts`)];
 const nodb=Array.from({length:963},(_,i)=>`test/n-${String(i).padStart(4,'0')}.test.ts`),all=[...db,...nodb].sort();
 const expected={sha:P.candidate,tree:P.tree,baseline:P.baseline,environmentHash:'e'.repeat(64),all,db,nodb};
 const inventory={all,db,nodb};
 const caseCount=i=>i===11?774:1000+i;
 const chunkLog=i=>i===11?fail():pass(chunkMembership(db,i).length,caseCount(i));
 const makeController=fresh=>{
  const chunks=Array.from({length:fresh?1:16},(_,i)=>(fresh?11:1)+i);
  let text=`▸ test lock: both slots held\n▸ tree: /fixture  branch: fixture  head: ${P.candidate.slice(0,9)}\n`;
  if(fresh)text+='▸ PARTIAL RUN — chunks 11..11 of 16 only\n';
  else text+='════ part (a) — 963 no-DB files, one run, 4 workers, no cluster, DB URLs on a closed port ════\n  exit=0  wall=1s\n'+pass(963,12550);
  const summaries=[];
  for(const i of chunks){const files=chunkMembership(db,i).length,bad=!fresh&&i===11,footer=bad?'1 failed | 60 passed (61)':`${files} passed (${files})`;
   text+=`════ part (b) chunk ${i}/16 — ${files} DB files ════\n exit=${bad?1:0}  peak-disk=n/a  wall=1s (rebuild+migrate+vitest)\n Test Files  ${footer}\n Tests  ${bad?'1 failed | 773 passed (774)':`${caseCount(i)} passed (${caseCount(i)})`}\n Duration  1.2s\n`;
   summaries.push(` chunk ${i}: exit=${bad?1:0} Test Files  ${footer}\n`);
  }
  text+='════ FINAL ════\n';
  if(!fresh)text+=' part a (no-DB): exit=0 Test Files  963 passed (963)\n';
  text+=summaries.join('')+` runs: ${fresh?1:17}   files counted: ${fresh?61:1944} of 1944 in the suite (963 no-DB + 981 DB)\n`;
  return text+(fresh?' SLICE GREEN — chunks 11..11 of 16. THIS IS NOT A GATE.\n receipt: none written (a slice or a proof run is not a gate)\n':' GATE RED — read the logs in /fixture\n receipt: .gate-receipt.json  result=FAIL tier=full sha=f20275ffa\n');
 };
 const originalReceipt={sha:P.candidate,result:'FAIL',tier:'full',at:'2026-10-25T14:00:00Z'};
 const commands=[['rebuild-focused',['bash','scripts/dev-db-rebuild.sh'],0],['migrate-focused',['pnpm','db:migrate'],0],['focused-repairs',['pnpm','exec','vitest','run','test/r291-detached-deploy.test.ts','test/leave-type-referrers.test.ts'],0],['whole-typecheck',['pnpm','exec','tsc','--noEmit'],0],['production-build',['pnpm','exec','next','build'],0],...['chromium','firefox','webkit'].map(e=>['browser-'+e,['pnpm','exec','vitest','run','--config',`.vitest-attachments/board3-local080-${e}.config.mts`],0]),['full-gate',['bash','scripts/gate.sh','--full',P.baseline],1]];
 const original={runnerHash:P.originalRunner,inventory,plan:{sha:P.candidate,base:P.baseline,deployed:P.baseline,environmentHash:expected.environmentHash,plan:{tier:'full',run:all}},learning:{sha:P.candidate,result:'FAIL',tier:'full',environmentHash:expected.environmentHash,failed:[P.test],fullReceipt:originalReceipt},receipt:originalReceipt,
  result:{sha:P.candidate,success:false,error:'RuntimeError: full-gate failed with exit 1',ownedPgSmartStopped:true,privatePort:5439,releaseEvidence:false,startedAt:100,endedAt:200,steps:commands.map(([name,command,exitCode],i)=>({name,command,exitCode,ownedProcessGroup:1000+i,startedAt:101+i*2,endedAt:102+i*2}))},
  noDbLog:pass(963,12550),controller:makeController(false),chunkLogs:Array.from({length:16},(_,i)=>chunkLog(i+1)),focusedLog:pass(2,55),buildLog:'✓ Compiled successfully\nFinished TypeScript\n✓ Generating static pages\nFinalizing page optimization\n',
  browserLogs:Object.fromEntries(['chromium','firefox','webkit'].map(e=>[e,' Test Files  16 passed (16)\n Tests  250 passed | 1 expected fail (251)\n Duration  1s\n']))};
 original.plan.plan={tier:'full',policyVersion:3,run:all.slice(0,1895)};
 original.plan.plan.fingerprint=digest(JSON.stringify(original.plan.plan));
 original.learning.plan=structuredClone(original.plan.plan);
 const identity='/opt/homebrew/var/aihr-pg16|'+P.sharedSystem,shared={identity,databases:['1|postgres|1'],roles:['1|postgres|true|true|true|true']};
 const directory='/fixture/fresh',freshCommands=[['borrow-canonical-stop',['python3',directory+'/borrow-canonical.py','stop'],0],['repair-batch-11',['bash','scripts/gate-chunked.sh'],0],['capture-canonical-environment',['node','--import','tsx',directory+'/capture-environment.mjs',directory+'/canonical-environment.json'],0]];
 const fresh={directory,scriptHashes:{...P.freshScripts},sha:P.candidate,baseline:P.baseline,environmentHash:expected.environmentHash,inventory,range:{chunks:16,from:11,to:11,workers:2},
  result:{sha:P.candidate,success:true,error:null,ownedPgSmartStopped:true,privatePort:5433,privatePgdata:'/fixture/owned',releaseEvidence:false,sliceOnly:true,fullReceiptRemains:'FAIL',originalWindowStartedAt:100,startedAt:201,endedAt:300},
  endpoint:{candidate:P.candidate,environmentHash:expected.environmentHash,jit:'on',version:'PostgreSQL 16.14 fixture',dataDirectory:'/fixture/owned',systemIdentifier:'7700000001',connections:{application:{name:'ai_hr_app',rolsuper:false,rolbypassrls:false,server_addr:'127.0.0.1',server_port:5433,database:'ai_hr_test',database_oid:'123'},migration:{name:'postgres',server_addr:'127.0.0.1',server_port:5433,database:'ai_hr_test',database_oid:'123'}}},
  receiptBefore:JSON.stringify(originalReceipt),receiptAfter:JSON.stringify(originalReceipt),focusedLog:pass(1,2),controller:makeController(true),chunkLogs:Array.from({length:1},(_,i)=>pass(61,caseCount(i+11))),
  sharedBefore:{...shared,at:201},sharedStopped:{at:202,systemIdentifier:P.sharedSystem,dataPreserved:true,onlyLifecycleOperation:'pg_ctl smart stop',databaseMutations:0},sharedAfter:{...shared,at:299,sameClusterAndDatabaseOidsAndRoles:true,databaseMutations:0}};
 fresh.result.startedAt=221;fresh.sharedBefore.at=221;fresh.sharedStopped.at=222;
 fresh.result.steps=freshCommands.map(([name,command,exitCode],i)=>({name,command,exitCode,ownedProcessGroup:2000+i,startedAt:221+i*2,endedAt:222+i*2}));
 const admission={runnerHash:P.interruptedRunner,result:{sha:P.candidate,success:false,error:'RuntimeError: Owned verification interrupted',ownedPgSmartStopped:false,releaseEvidence:false,startedAt:201,endedAt:220,originalWindowStartedAt:100,steps:[{name:'borrow-canonical-stop',command:['python3',directory+'/borrow-canonical.py','stop'],exitCode:0},{name:'repair-batch-11',command:['bash','scripts/gate-chunked.sh']}]},
  controller:'▸ test lock: acquiring 1 more slot(s) — blocks until running vitest/tsc/gates release them\ntestlock: gate-b waiting; held by: board3-local081-db \n',receiptBefore:fresh.receiptBefore,sharedBefore:structuredClone({...shared,at:201}),sharedAfter:structuredClone({...shared,at:219,sameClusterAndDatabaseOidsAndRoles:true,databaseMutations:0})};
 return {input:{original,fresh,admission,authorization:{scope:P.authorization,threadId:'01a16508-ab6a-7e72-8b47-5dd1c6012ace'}},expected};
}
test('Complete original failed attempt stays FAIL; separate successful batch11 supplies complete test coverage',()=>{
 const {input,expected}=fixture(),proof=validateLocalEnvironmentRepair(input,expected);
 assert.equal(proof.tier,'local-environment-repair');assert.equal(proof.originalResult,'FAIL');assert.equal(proof.coverage.files,1944);assert.equal(proof.coverage.retained.length,15);assert.equal(proof.coverage.fresh.length,1);assert.equal(input.original.receipt.result,'FAIL');assert.equal(proof.arrivalVerified,false);assert.equal('result' in proof,false);
});
const refusals={
 'different candidate':(a,e)=>e.sha='b'.repeat(40),
 'different source tree':(a,e)=>e.tree='b'.repeat(40),
 'different deployed baseline':(a,e)=>e.baseline='b'.repeat(40),
 'different original runner':a=>a.original.runnerHash='f'.repeat(64),
 'missing inventory file':a=>a.original.inventory={...a.original.inventory,all:a.original.inventory.all.slice(1)},
 'original classifier changed':a=>a.original.inventory={...a.original.inventory,db:[...a.original.inventory.db].reverse()},
 'original full plan became selected':a=>a.original.plan.plan.tier='impact',
 'original failed receipt relabelled':a=>a.original.receipt={...a.original.receipt,result:'PASS'},
 'extra failed test':a=>a.original.learning.failed.push('test/other.test.ts'),
 'original owner cleanup unconfirmed':a=>a.original.result.ownedPgSmartStopped=false,
 'original still running':a=>delete a.original.result.endedAt,
 'original missing terminal chunk':a=>a.original.chunkLogs.pop(),
 'original extra failed batch':a=>a.original.controller=a.original.controller.replace('chunk 5: exit=0','chunk 5: exit=1'),
 'original repeated final':a=>a.original.controller+='════ FINAL ════\n',
 'original interrupted no-DB':a=>a.original.noDbLog=a.original.noDbLog.replace('Duration','Interrupted'),
 'original failing compiler':a=>a.original.result.steps.find(s=>s.name==='whole-typecheck').exitCode=1,
 'original unbounded compiler command':a=>a.original.result.steps.find(s=>s.name==='whole-typecheck').command.push('--skipLibCheck'),
 'original build incomplete':a=>a.original.buildLog='✓ Compiled successfully',
 'original browser case missing':a=>a.original.browserLogs.webkit=a.original.browserLogs.webkit.replace('250 passed','249 passed'),
 'original endpoint different failure case':a=>a.original.chunkLogs[10]=a.original.chunkLogs[10].replace(P.case,'another case'),
 'original endpoint different error':a=>a.original.chunkLogs[10]=a.original.chunkLogs[10].replace('Actual Reports role/database proof refused.','other failure'),
 'missing human scope':a=>a.authorization.scope='rerun only one batch',
 'fresh changed environment':a=>a.fresh.environmentHash='b'.repeat(64),
 'missing prior failed admission':a=>delete a.admission,
 'prior admission relabelled':a=>a.admission.result.success=true,
 'prior admission ran tests':a=>a.admission.controller+=' Test Files  61 passed (61)\n',
 'prior admission source changed':a=>a.admission.runnerHash='f'.repeat(64),
 'prior admission restore changed':a=>a.admission.sharedAfter.roles=[],
 'fresh wrong range':a=>a.fresh.range.to=16,
 'fresh more workers':a=>a.fresh.range.workers=4,
 'fresh reviewed script changed':a=>a.fresh.scriptHashes['run.py']='e'.repeat(64),
 'fresh missing process':a=>a.fresh.result.steps.pop(),
 'fresh partial test command':a=>a.fresh.result.steps.at(-1).command.push('test/one.test.ts'),
 'fresh failed process':a=>a.fresh.result.success=false,
 'fresh port 5439':a=>a.fresh.endpoint.connections.application.server_port=5439,
 'fresh privileged application role':a=>a.fresh.endpoint.connections.application.rolbypassrls=true,
 'fresh owner database mismatch':a=>a.fresh.endpoint.connections.migration.database_oid='456',
 'fresh JIT disabled':a=>a.fresh.endpoint.jit='off',
 'fresh wrong PGDATA':a=>a.fresh.endpoint.dataDirectory='/another',
 'fresh borrowed foreign data':a=>a.fresh.endpoint.systemIdentifier=P.sharedSystem,
 'fresh failed full receipt rewritten':a=>a.fresh.receiptAfter+=' ',
 'fresh missing batch11':a=>a.fresh.chunkLogs.pop(),
 'fresh repeated batch':a=>a.fresh.controller=a.fresh.controller.replace('chunk 11/16','chunk 12/16'),
 'fresh assertion disappeared':a=>a.fresh.chunkLogs[0]=pass(61,773),
 'fresh natural footer missing':a=>a.fresh.chunkLogs[0]=a.fresh.chunkLogs[0].replace('Duration','killed'),
 'fresh late window':a=>a.fresh.result.endedAt=100+8*3600+1,
 'fresh overlap with original':a=>a.fresh.result.startedAt=199,
 'foreign restore unconfirmed':a=>a.fresh.sharedAfter.sameClusterAndDatabaseOidsAndRoles=false,
 'foreign database removed':a=>a.fresh.sharedAfter.databases=[],
 'foreign role changed':a=>a.fresh.sharedAfter.roles=['1|postgres|false'],
 'foreign identity changed':a=>a.fresh.sharedAfter.identity+='1',
 'foreign mutation admitted':a=>a.fresh.sharedStopped.databaseMutations=1,
};
for(const [name,mutate] of Object.entries(refusals))test('Refuses '+name,()=>{const {input,expected}=fixture();mutate(input,expected);assert.throws(()=>validateLocalEnvironmentRepair(input,expected));});
test('Incomplete original fails before any fresh result can confer authority',()=>{const {input,expected}=fixture();input.original.controller=input.original.controller.split('════ FINAL')[0];assert.throws(()=>validateOriginalPortAttempt(input.original,expected),/naturally complete/);});
