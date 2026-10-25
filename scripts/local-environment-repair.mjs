/** One owner-approved, same-source local port repair. Never changes a full receipt. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {passedPhase} from './gate-phase-reuse.ts';

export const LOCAL_REPAIR = Object.freeze({
 version:1, tier:'local-environment-repair', repository:'StradaverseHub/ai-hr',
 candidate:'f20275ffa150ecc41b745f625f085308ea283379',
 tree:'1b38bb08fddbcefb682240e42871db9d1869ad48',
 baseline:'c98bfed60f6330b57f5a67d959ce6e3757df3b53',
 interruptedRunner:'079854f04638b40b6717bd804123028ea6e3d15afb3356b5ff3713bccfd00e91',
 originalRunner:'2a56d35bd8b415aecb4423132cc7014fd780dc0cbd09d1b2c9a9a04f9918d7ba',
 originalImpactFingerprint:'54bbf0f488b126723fa8e3dae89346aae1e26f9c6093e2ae9ba0d58439bc4946',
 chunks:16, from:11, to:11, workers:2,
 sharedSystem:'7700576020832388449',
 test:'test/report-fixture-connection.test.ts',
 case:'actual Reports fixture loopback endpoint proof > accepts actual PostgreSQL host addresses while inet text retains its network prefix',
 authorization:'Wait, if 12-16 passed, we only need to rerun gate 11 for deployment right? Dont need to rerun 11-16',
 freshScripts:Object.freeze({'run.py':'6ec218fa90c0b2cc8443d2182d14ad22c4ced5d6dde1610260f6b8eef2a55e0f','borrow-canonical.py':'f656711ac6fc8857f1a245ab73b23bd42a08f889c879b05420dc4b7a30bd9f8c','capture-environment.mjs':'a0a113412e17a94c332ee83c1b7e59ee2475b9a2c7f85b77806d1de04946a979'}),
});
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const plain=text=>text.replace(/\u001b\[[0-9;]*m/g,'');
export function requireRepair(ok,why){if(!ok)throw Error('Local environment repair refused: '+why);}
const one=(text,regexp,why)=>{const ms=[...text.matchAll(regexp)];requireRepair(ms.length===1,why);return ms[0];};
const sorted=files=>Array.isArray(files)&&files.length>0&&files.every((f,i)=>/^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(f)&&(i===0||files[i-1]<f));
const integer=n=>Number.isSafeInteger(n)&&n>0;
export const chunkMembership=(db,number)=>db.filter((_,i)=>i%LOCAL_REPAIR.chunks===number-1);

function failedEndpoint(log,asked){
 const text=plain(log);
 const f=one(text,/^\s*Test Files\s+(\d+) failed \| (\d+) passed \((\d+)\)\s*$/gm,'one original failed-file footer');
 const t=one(text,/^\s*Tests\s+(\d+) failed \| (\d+) passed \((\d+)\)\s*$/gm,'one original failed-test footer');
 requireRepair(+f[1]===1&&+f[2]===asked-1&&+f[3]===asked&&+t[1]===1&&+t[2]===773&&+t[3]===774,'original failure/counts differ');
 requireRepair([...text.matchAll(/^\s*Test Files\s+/gm)].length===1&&[...text.matchAll(/^\s*Tests\s+/gm)].length===1,'repeated original summary');
 const failure=one(text,/^\s*FAIL\s+\|node\|\s+(test\/\S+) > (.+)$/gm,'one original failure');
 requireRepair(failure[1]===LOCAL_REPAIR.test&&failure[2]===LOCAL_REPAIR.case,'not the sole approved endpoint failure');
 requireRepair(text.includes('"Error: Actual Reports role/database proof refused."'),'missing actual endpoint refusal');
 requireRepair(/^\s*Duration\s+\S/m.test(text)&&!/^\s*(?:Errors?\s|Unhandled\s)/m.test(text),'incomplete original failure');
 return {files:asked,tests:+t[3]};
}

function controller(text,db,{fresh=false}={}){
 text=plain(text);
 requireRepair(text.includes('head: '+LOCAL_REPAIR.candidate.slice(0,9)),'controller source identity');
 requireRepair(text.includes('▸ test lock: both slots held'),'official slots not held');
 one(text,/^════ FINAL ════$/gm,'controller is not naturally complete');
 const headers=[...text.matchAll(/^════ part \(b\) chunk (\d+)\/(\d+) — (\d+) DB files ════$/gm)];
 const start=fresh?LOCAL_REPAIR.from:1,end=fresh?LOCAL_REPAIR.to:LOCAL_REPAIR.chunks;
 requireRepair(headers.length===end-start+1,'missing/duplicate/out-of-scope chunk');
 requireRepair(fresh?text.includes('▸ PARTIAL RUN — chunks 11..11 of 16 only'):!text.includes('PARTIAL RUN'),'wrong full/slice mode');
 requireRepair(!text.includes('PROOF'),'proof-only run');
 const summaries=[...text.matchAll(/^\s*chunk (\d+): exit=(\d+)\s+(Test Files[^\n]+)$/gm)];
 requireRepair(summaries.length===headers.length,'incomplete final chunk summaries');
 const phases=[];
 for(let i=0;i<headers.length;i++){
  const number=start+i,asked=chunkMembership(db,number).length,h=headers[i],s=summaries[i];
  requireRepair(+h[1]===number&&+h[2]===16&&+h[3]===asked&&+s[1]===number,'chunk order/partition changed');
  const section=text.slice(h.index+h[0].length,headers[i+1]?.index??text.indexOf('════ FINAL ════'));
  const exit=one(section,/^\s*exit=(\d+)\s+peak-disk=\S+\s+wall=\d+s \(rebuild\+migrate\+vitest\)\s*$/gm,'missing/repeated natural chunk exit');
  const wanted=!fresh&&number===11?1:0;
  requireRepair(+exit[1]===wanted&&+s[2]===wanted,'unexpected failed/successful chunk');
  const fileFooter=one(section,/^\s*Test Files\s+(.+)$/gm,'one controller file summary')[1].trim();
  requireRepair(s[3].trim()==='Test Files  '+fileFooter||s[3].replace(/\s+/g,' ').trim()==='Test Files '+fileFooter.replace(/\s+/g,' '),'final/body file-count disagreement');
  const tests=one(section,/^\s*Tests\s+(.+)$/gm,'one controller test summary')[1].trim();
  if(wanted===1){
   requireRepair(fileFooter===`1 failed | ${asked-1} passed (${asked})`&&tests==='1 failed | 773 passed (774)','original endpoint failure summary differs');
   phases.push({number,files:asked,tests:774,exit:1});
  }else phases.push({number,...passedPhase(section,asked),exit:0});
 }
 const total=one(text,/^\s*runs: (\d+)\s+files counted: (\d+) of (\d+) in the suite \((\d+) no-DB \+ (\d+) DB\)\s*$/gm,'one complete total');
 const selected=phases.reduce((n,p)=>n+p.files,0);
 requireRepair(+total[1]===(fresh?1:17)&&+total[2]===(fresh?selected:1944)&&+total[3]===1944&&+total[4]===963&&+total[5]===981,'complete suite/slice counts differ');
 if(fresh){
  requireRepair(!/^════ part \(a\)/m.test(text)&&!/^\s*part a \(no-DB\):/m.test(text),'unexpected fresh no-DB run');
  requireRepair(text.includes('SLICE GREEN — chunks 11..11 of 16. THIS IS NOT A GATE.')&&text.includes('receipt: none written (a slice or a proof run is not a gate)')&&!text.includes('GATE RED'),'fresh slice not successful/unaltered');
 }else{
  requireRepair(text.includes('GATE RED — read the logs')&&text.includes('receipt: .gate-receipt.json  result=FAIL tier=full'),'original failure is not preserved');
  one(text,/^\s*part a \(no-DB\): exit=0\s+Test Files\s+963 passed \(963\)\s*$/gm,'original no-DB final exit/count');
 }
 return phases;
}

function steps(result,expected){
 requireRepair(Array.isArray(result.steps)&&result.steps.length===expected.length,'unexpected process inventory');
 let last=result.startedAt;
 for(let i=0;i<expected.length;i++){
  const step=result.steps[i],[name,command,exit]=expected[i];
  requireRepair(step.name===name&&equal(step.command,command)&&step.exitCode===exit,'process command or exit differs: '+name);
  requireRepair(integer(step.ownedProcessGroup)&&Number.isFinite(step.startedAt)&&Number.isFinite(step.endedAt)&&step.startedAt>=last&&step.endedAt>=step.startedAt&&step.endedAt<=result.endedAt,'process lifetime incomplete: '+name);
  last=step.endedAt;
 }
}
const commonCommands=[['rebuild-focused',['bash','scripts/dev-db-rebuild.sh'],0],['migrate-focused',['pnpm','db:migrate'],0]];
export function validateOriginalPortAttempt(input,expected){
 requireRepair(expected.sha===LOCAL_REPAIR.candidate&&expected.tree===LOCAL_REPAIR.tree&&expected.baseline===LOCAL_REPAIR.baseline&&/^[a-f0-9]{64}$/.test(expected.environmentHash),'unapproved source/baseline/environment');
 const {all,db,nodb}=expected;
 requireRepair(sorted(all)&&sorted(db)&&sorted(nodb)&&all.length===1944&&db.length===981&&nodb.length===963&&equal([...db,...nodb].sort(),all),'independent inventory is incomplete');
 requireRepair(equal(input.inventory,{all,db,nodb}),'archived classifier partition changed');
 requireRepair(input.runnerHash===LOCAL_REPAIR.originalRunner,'original wrapper bytes changed');
 const plan=input.plan;
 requireRepair(plan.sha===expected.sha&&plan.base===expected.baseline&&plan.deployed===expected.baseline&&plan.environmentHash===expected.environmentHash&&plan.plan?.tier==='full'&&plan.plan.policyVersion===3,'original full plan differs');
 const {fingerprint,...planBody}=plan.plan;
 requireRepair(fingerprint===digest(JSON.stringify(planBody))&&sorted(plan.plan.run)&&plan.plan.run.length===1895&&plan.plan.run.every(p=>all.includes(p)),'original forced-full impact plan differs');
 requireRepair(input.learning.sha===expected.sha&&input.learning.result==='FAIL'&&input.learning.tier==='full'&&input.learning.environmentHash===expected.environmentHash&&equal(input.learning.failed,[LOCAL_REPAIR.test]),'original failure inventory/identity differs');
 requireRepair(equal(input.learning.plan,plan.plan),'original recorded impact plan changed');
 requireRepair(equal(input.receipt,input.learning.fullReceipt)&&input.receipt.sha===expected.sha&&input.receipt.result==='FAIL'&&input.receipt.tier==='full','authentic failed full receipt missing/altered');
 const r=input.result;
 requireRepair(r.sha===expected.sha&&r.success===false&&r.error==='RuntimeError: full-gate failed with exit 1'&&r.ownedPgSmartStopped===true&&r.privatePort===5439&&r.releaseEvidence===false,'original attempt not terminal/cleaned or differently failed');
 requireRepair(Number.isFinite(r.startedAt)&&Number.isFinite(r.endedAt)&&r.endedAt>r.startedAt&&r.endedAt<=r.startedAt+8*3600,'original attempt lifetime');
 steps(r,[...commonCommands,['focused-repairs',['pnpm','exec','vitest','run','test/r291-detached-deploy.test.ts','test/leave-type-referrers.test.ts'],0],['whole-typecheck',['pnpm','exec','tsc','--noEmit'],0],['production-build',['pnpm','exec','next','build'],0],...['chromium','firefox','webkit'].map(e=>['browser-'+e,['pnpm','exec','vitest','run','--config',`.vitest-attachments/board3-local080-${e}.config.mts`],0]),['full-gate',['bash','scripts/gate.sh','--full',expected.baseline],1]]);
 const noDb=passedPhase(input.noDbLog,nodb.length);
 requireRepair(noDb.tests===12550,'original no-DB test inventory');
 const before=plain(input.controller).split('════ part (b)')[0];
 requireRepair(equal(passedPhase(before,nodb.length),noDb)&&/^\s*exit=0\s+wall=\d+s\s*$/m.test(before),'no-DB controller and log disagree');
 const chunks=controller(input.controller,db);
 requireRepair(Array.isArray(input.chunkLogs)&&input.chunkLogs.length===16,'all original chunks are required');
 for(let i=0;i<16;i++){
  const phase=i===10?failedEndpoint(input.chunkLogs[i],chunks[i].files):passedPhase(input.chunkLogs[i],chunks[i].files);
  requireRepair(phase.tests===chunks[i].tests,'original log/controller disagree: '+(i+1));
 }
 requireRepair(chunkMembership(db,11).includes(LOCAL_REPAIR.test),'endpoint file not in batch11');
 requireRepair(passedPhase(input.focusedLog,2).tests===55,'original focused repairs not verified');
 requireRepair(/✓ Compiled successfully/.test(input.buildLog)&&/Finished TypeScript/.test(input.buildLog)&&/✓ Generating static pages/.test(input.buildLog)&&/Finalizing page optimization/.test(input.buildLog),'production build completion missing');
 for(const engine of ['chromium','firefox','webkit']){
  const text=plain(input.browserLogs[engine]??'');
  one(text,/^\s*Test Files\s+16 passed \(16\)\s*$/gm,'browser file coverage '+engine);
  one(text,/^\s*Tests\s+250 passed \| 1 expected fail \(251\)\s*$/gm,'browser assertion coverage '+engine);
  requireRepair([...text.matchAll(/^\s*Test Files\s+/gm)].length===1&&[...text.matchAll(/^\s*Tests\s+/gm)].length===1&&/^\s*Duration\s+\S/m.test(text)&&!/^\s*(?:FAIL\s|Errors?\s|Unhandled\s)/m.test(text),'browser natural completion '+engine);
 }
 return {noDb,chunks,endedAt:r.endedAt,startedAt:r.startedAt,originalResult:'FAIL'};
}

export function validateLocalEnvironmentRepair({original,fresh,admission,authorization},expected){
 const old=validateOriginalPortAttempt(original,expected);
 requireRepair(authorization?.scope===LOCAL_REPAIR.authorization&&authorization.threadId==='01a16508-ab6a-7e72-8b47-5dd1c6012ace','explicit human resume scope missing');
 requireRepair(fresh.sha===expected.sha&&fresh.baseline===expected.baseline&&fresh.environmentHash===expected.environmentHash,'fresh source/baseline/environment changed');
 requireRepair(equal(fresh.inventory,original.inventory),'fresh inventory/partition changed');
 requireRepair(fresh.range?.chunks===16&&fresh.range.from===11&&fresh.range.to===11&&fresh.range.workers===2,'fresh range/worker count differs');
 const a=admission?.result;
 requireRepair(admission?.runnerHash===LOCAL_REPAIR.interruptedRunner&&a?.sha===expected.sha&&a.success===false&&a.error==='RuntimeError: Owned verification interrupted'&&a.ownedPgSmartStopped===false&&a.releaseEvidence===false,'prior interrupted admission missing/altered');
 requireRepair(a.startedAt>=old.endedAt&&a.endedAt>a.startedAt&&a.endedAt<=fresh.result.startedAt&&a.originalWindowStartedAt===old.startedAt,'prior admission chronology differs');
 requireRepair(a.steps?.length===2&&a.steps[0].name==='borrow-canonical-stop'&&a.steps[0].exitCode===0&&equal(a.steps[0].command,['python3',fresh.directory+'/borrow-canonical.py','stop'])&&a.steps[1].name==='repair-batch-11'&&equal(a.steps[1].command,['bash','scripts/gate-chunked.sh'])&&a.steps[1].exitCode===undefined&&a.steps[1].endedAt===undefined,'prior admission process scope differs');
 requireRepair(admission.controller.trim()==='▸ test lock: acquiring 1 more slot(s) — blocks until running vitest/tsc/gates release them\ntestlock: gate-b waiting; held by: board3-local081-db','prior admission did not stop before tests');
 requireRepair(admission.receiptBefore===fresh.receiptBefore,'prior admission changed the failed receipt');
 const ab=admission.sharedBefore,aa=admission.sharedAfter;
 requireRepair(ab?.identity?.endsWith('|'+LOCAL_REPAIR.sharedSystem)&&aa?.identity===ab.identity&&Array.isArray(ab.databases)&&ab.databases.length>0&&Array.isArray(ab.roles)&&ab.roles.length>0&&equal(ab.databases,aa.databases)&&equal(ab.roles,aa.roles)&&aa.sameClusterAndDatabaseOidsAndRoles===true&&aa.databaseMutations===0&&aa.at<=a.endedAt,'prior admission shared restoration missing/changed');
 const r=fresh.result;
 requireRepair(r.sha===expected.sha&&r.success===true&&r.error===null&&r.ownedPgSmartStopped===true&&r.privatePort===5433&&r.releaseEvidence===false&&r.sliceOnly===true&&r.fullReceiptRemains==='FAIL','fresh process incomplete/failed or receipt relabelled');
 requireRepair(r.originalWindowStartedAt===old.startedAt&&r.startedAt>=old.endedAt&&r.endedAt>r.startedAt&&r.endedAt<=old.startedAt+8*3600,'fresh process exceeded original bounded window or overlapped original');
 steps(r,[['borrow-canonical-stop',['python3',fresh.directory+'/borrow-canonical.py','stop'],0],['repair-batch-11',['bash','scripts/gate-chunked.sh'],0],['capture-canonical-environment',['node','--import','tsx',fresh.directory+'/capture-environment.mjs',fresh.directory+'/canonical-environment.json'],0]]);
 requireRepair(equal(fresh.scriptHashes,LOCAL_REPAIR.freshScripts),'fresh reviewed wrapper changed');
 const p=fresh.endpoint;
 requireRepair(p?.candidate===expected.sha&&p.environmentHash===expected.environmentHash&&p.jit==='on'&&/^PostgreSQL 16\./.test(p.version)&&p.dataDirectory===r.privatePgdata&&/^\d+$/.test(p.systemIdentifier)&&p.systemIdentifier!==LOCAL_REPAIR.sharedSystem,'fresh actual PostgreSQL settings/identity missing');
 const {application:app,migration:owner}=p.connections??{};
 requireRepair(app?.name==='ai_hr_app'&&app.rolsuper===false&&app.rolbypassrls===false&&['127.0.0.1','::1'].includes(app.server_addr)&&app.server_port===5433&&owner?.server_port===5433&&owner.server_addr===app.server_addr&&owner.name==='postgres'&&owner.database===app.database&&owner.database_oid===app.database_oid&&/^\d+$/.test(app.database_oid),'fresh actual endpoint roles/port/OID invalid');
 requireRepair(fresh.receiptBefore===fresh.receiptAfter&&equal(JSON.parse(fresh.receiptBefore),original.receipt),'failed full receipt was changed');
 const repaired=controller(fresh.controller,expected.db,{fresh:true});
 requireRepair(Array.isArray(fresh.chunkLogs)&&fresh.chunkLogs.length===1,'the fresh batch11 log is required');
 for(let i=0;i<1;i++){
  const phase=passedPhase(fresh.chunkLogs[i],repaired[i].files),oldPhase=old.chunks[i+10];
  requireRepair(phase.tests===repaired[i].tests&&phase.tests===oldPhase.tests,'fresh counts differ from original complete inventory: '+(i+11));
 }
 const before=fresh.sharedBefore,after=fresh.sharedAfter,stopped=fresh.sharedStopped;
 requireRepair(before?.identity?.endsWith('|'+LOCAL_REPAIR.sharedSystem)&&after?.identity===before.identity&&Array.isArray(before.databases)&&before.databases.length>0&&Array.isArray(before.roles)&&before.roles.length>0&&equal(before.databases,after.databases)&&equal(before.roles,after.roles)&&after.sameClusterAndDatabaseOidsAndRoles===true&&after.databaseMutations===0,'shared database restoration missing/changed');
 requireRepair(stopped?.systemIdentifier===LOCAL_REPAIR.sharedSystem&&stopped.dataPreserved===true&&stopped.onlyLifecycleOperation==='pg_ctl smart stop'&&stopped.databaseMutations===0&&Number.isFinite(before.at)&&stopped.at>=before.at&&after.at>stopped.at&&after.at<=r.endedAt,'shared stop/restore provenance missing');
 return {policyVersion:LOCAL_REPAIR.version,tier:LOCAL_REPAIR.tier,sha:expected.sha,baseline:expected.baseline,originalResult:'FAIL',priorAdmission:'INTERRUPTED_BEFORE_TESTS',coverage:{files:expected.all.length,nodb:old.noDb,retained:old.chunks.filter(p=>p.number!==11),fresh:repaired},compiler:'separate-original-whole-typecheck',build:'separate-original-production-build',browsers:'separate-original-three-engine-checks',arrivalVerified:false};
}
