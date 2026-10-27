/** Low-level cached-byte reader. The operator supplies independently fetched API and immutable-source inputs.
 * This does not trust authentication.json or a caller self-hash, and cannot issue a grant. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {inspectFocusedInventory} from './authenticated-focused.mjs';
import {readCiArchive} from './archive-downloads.mjs';
import {parseSelection} from './focused-checks.mjs';
import {inspectFocusedFiles} from './focused-file-evidence.mjs';
import {authenticateFocusedPdfTools} from './authenticated-focused-pdf.mjs';
export async function inspectFocusedSnapshotArchive({repository,expected,snapshot,reconstructed,archivePath,directory}){
 const origin=inspectFocusedInventory({...snapshot,expected}),plan=reconstructed.plan;
 assert(plan.sha===expected.candidate&&plan.controller===expected.controller&&plan.migrationBase===expected.baseline,'Actual immutable plan tuple differs');
 mkdirSync(directory,{mode:0o700});readCiArchive(origin.artifact,archivePath);const extracted=join(directory,'evidence');
 execFileSync('python3',[fileURLToPath(new URL('./extract-focused.py',import.meta.url)),archivePath,extracted],{timeout:10000,stdio:'pipe'});
 const report=JSON.parse(readFileSync(join(extracted,'focused.json'))),files=parseSelection(JSON.stringify(report.files));assert(files.every(f=>plan.suite.includes(f)),'Foreign selected source member');
 const groups={NODB:[],DB:[]};for(const f of files){const unit=plan.units.find(u=>u.files.includes(f));assert(unit&&['db','nodb'].includes(unit.kind));groups[unit.kind==='db'?'DB':'NODB'].push(f);}
 const classifier=execFileSync('git',['-C',repository,'show',expected.candidate+':scripts/gate-db-classify.ts']);assert(classifier.equals(execFileSync('git',['-C',repository,'show',expected.controller+':scripts/gate-db-classify.ts'])),'Candidate classifier differs');
 const wanted=new Set(['focused.json',...Object.entries(groups).filter(([,fs])=>fs.length).map(([kind])=>kind.toLowerCase()+'.vitest.json')]);for(const name of ['nodb.vitest.json','db.vitest.json'])assert.equal(existsSync(join(extracted,name)),wanted.has(name),'Extra/missing raw group');
 const results=new Map(Object.entries(groups).filter(([,fs])=>fs.length).map(([kind])=>[kind,JSON.parse(readFileSync(join(extracted,kind.toLowerCase()+'.vitest.json')))]));
 const outcome=inspectFocusedFiles({report,results,expected:{...expected,runtime:plan.runtime,files,groups,classifierHash:createHash('sha256').update(classifier).digest('hex')},postgresExecution:plan.execution});
 const pdfTooling=await authenticateFocusedPdfTools({files,plan,run:snapshot.run,job:origin.job,artifacts:snapshot.artifacts,directory});
 assert.equal(origin.job.conclusion,report.exitCode?'failure':'success');assert(Date.parse(report.startedAt)>=Date.parse(origin.job.started_at)&&Date.parse(report.endedAt)<=Date.parse(origin.job.completed_at));
 if(groups.DB.length){const cleanup=origin.job.steps?.filter(s=>s.name==='Ensure owned database cleanup after interrupted checks');assert(cleanup?.length===1&&cleanup[0].status==='completed'&&cleanup[0].conclusion==='success','Actual owned DB cleanup missing');}
 return {...outcome,kind:'AUTHENTICATED_FOCUSED_FILE_OUTCOMES_NOT_COMBINED_RELEASE',sourceBinding:reconstructed.binding,pdfTooling,origin:{...expected,artifactId:origin.artifact.id,digest:origin.artifact.digest,jobId:origin.job.id},evidenceDirectory:directory};
}
