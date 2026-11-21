/** Check exact hosted evidence and send a small source delta to the staging pickup service. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseIndex} from './index-expansion.mjs';
import {expectedBaselineMigrationLedger,expectedMigrationLedger} from '../../.github/ci/staging-migration-ledger.mjs';
import {REPOSITORY,REPOSITORY_ID} from '../../.github/ci/release-policy.mjs';

const [cwd,baseline,build,runID,smoke] = process.argv.slice(2);
assert.match(baseline??'',/^[a-f0-9]{40}$/);
assert.match(build??'',/^[A-Za-z0-9_-]{1,128}$/);
const run=Number(runID);
assert(Number.isSafeInteger(run)&&run>0);
const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:12000,maxBuffer:2**21});
assert.equal(git('status','--porcelain','--untracked-files=normal'),'','Freeze the candidate first');
const candidate=git('rev-parse','HEAD').trim();
assert.equal(git('merge-base',baseline,candidate).trim(),baseline);
const before=expectedBaselineMigrationLedger(cwd,baseline);
const after=expectedMigrationLedger(cwd);
assert.equal(after.length,before.length+1);
const row=after.at(-1);
assert(before.every(entry=>BigInt(row.created_at)>BigInt(entry.created_at)));
const sql=`db/migrations/${row.tag}.sql`;
const index=parseIndex(readFileSync(path.join(cwd,sql)));
assert.equal(index.digest,row.hash);
const workflow='.github/workflows/staging-schema-only.yml';
const test='deploy/upgrade/schema-only.test.mjs';
const controller=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
for(const proof of [workflow,test,'deploy/upgrade/index-expansion.mjs','db/migrations/0518_clocking_file_import.sql','patches/postgres@3.4.9.patch']){
  assert(readFileSync(path.join(cwd,proof)).equals(readFileSync(path.join(controller,proof))), 'Reviewed evidence input differs: '+proof);
}
const allowed=new Set([workflow,test,sql,'db/migrations/meta/_journal.json','docs/MIGRATION-ALLOCATION.md']);
const entries=git('diff','--name-status','-z','--no-renames',baseline,candidate).split('\0').slice(0,-1);
const files={};
assert(entries.length>0 && entries.length%2===0);
for(let i=0;i<entries.length;i+=2){
  const [change,file]=entries.slice(i,i+2);
  assert(['A','M'].includes(change)&&allowed.has(file), 'Runtime input changed: '+file);
  const mode=ref=>git('ls-tree',ref,'--',file).split(' ')[0].trim();
  assert.equal(mode(candidate),'100644');
  assert.equal(mode(baseline),change==='M'?'100644':'');
  const original=change==='M'?createHash('sha256').update(git('show',`${baseline}:${file}`)).digest('hex'):null;
  files[file]={before:original,text:git('show',`${candidate}:${file}`)};
}
assert(files[sql]&&files['db/migrations/meta/_journal.json']);
const api=suffix=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${suffix}`],{encoding:'utf8',timeout:15000}));
const evidence=api(`actions/runs/${run}`);
assert(evidence.id===run&&evidence.head_sha===candidate&&evidence.repository?.id===REPOSITORY_ID
  &&evidence.head_repository?.id===REPOSITORY_ID&&evidence.head_branch===git('branch','--show-current').trim()
  &&evidence.head_branch.startsWith('codex/staging-schema-only-')&&evidence.path===workflow
  &&evidence.event==='push'&&evidence.run_attempt===1&&evidence.status==='completed'&&evidence.conclusion==='success'
  &&Date.now()-Date.parse(evidence.updated_at)<86400000,'Exact fresh schema-only rehearsal not verified');
const jobs=api(`actions/runs/${run}/jobs?per_page=100`);
assert.equal(jobs.total_count,1);
assert.equal(jobs.jobs[0].name,'expansion-and-rollback');
assert.equal(jobs.jobs[0].conclusion,'success');
const result=spawnSync('ssh',['-F',realpathSync(process.env.AIHR_SSH_CONFIG),'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=12','aihr-staging',
  'python3 -B /var/tmp/aihr-deploy/staging-release-queue/schema-only.py register'],{
  input:JSON.stringify({candidate,baseline,build,tag:row.tag,run,smoke,sqlSha256:index.digest,files}),encoding:'utf8',timeout:60000});
assert.equal(result.status,0,result.stderr||result.error?.message);
console.log(JSON.stringify(JSON.parse(result.stdout)));
