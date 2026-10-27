/** Reconstruct coverage from immutable Git blobs using this trusted controller's classifier.
 * Candidate code is read, never imported or executed. This is not release authority.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {balanceDatabaseFiles,validateDurationHints} from './db-scheduling.mjs';
import {readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {classifyTestFiles} from '../../scripts/gate-db-classify.ts';
import {CI_POLICY} from './policy-version.mjs';
import {CI_EXECUTION,DB_BATCH_FILES,buildUnits,hash} from './manifest.mjs';
import {classifyPdfToolSources} from './pdf-tool-scope.mjs';
const relevant=/^(?:app|components|core|db|lib|localization|mobile|packs|scripts|test)\/.+\.(?:ts|tsx|js|mjs|cjs|mts|cts|py|sh|sql)$/;
const safe=p=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!p.includes('\\')&&!p.split('/').some(v=>!v||v==='.'||v==='..');
export function immutablePlan({repository,candidate,controller,baseline,runtime}){
 for(const id of [candidate,controller,baseline])assert(/^[a-f0-9]{40}$/.test(id??''),'Exact immutable commit identities required');
 assert(runtime&&Object.keys(runtime).sort().join(',')==='arch,node,platform'&&Object.values(runtime).every(x=>typeof x==='string'&&x.length>0),'Bound runtime tuple required');
 const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',maxBuffer:32*1024**2}).trim();
 for(const id of [candidate,controller,baseline])assert(git('cat-file','-t',id)==='commit','Expected existing commit');
 execFileSync('git',['-C',repository,'merge-base','--is-ancestor',baseline,candidate],{stdio:'pipe'});
 // Explicitly refuse a controller whose planning policy differs; never silently reinterpret old topology.
 for(const path of ['.github/ci/manifest.mjs','.github/ci/db-scheduling.mjs','.github/ci/pdf-tool-scope.mjs','scripts/gate-db-classify.ts']){
  const actual=execFileSync('git',['-C',repository,'show',controller+':'+path],{maxBuffer:16*1024**2});
  const local=readFileSync(new URL(path.startsWith('scripts/')?'../../'+path:'./'+path.split('/').at(-1),import.meta.url));
  assert(actual.equals(local),'Controller planning inputs differ from this planner: '+path);
 }
 const historicalInputs=['.github/ci/policy-version.mjs','.github/ci/db-duration-hints.json'].map(path=>execFileSync('git',['-C',repository,'show',controller+':'+path],{maxBuffer:16*1024**2}));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 const localInputs=['policy-version.mjs','db-duration-hints.json'].map(path=>readFileSync(new URL('./'+path,import.meta.url)));
 const isCurrent=historicalInputs.every((b,i)=>b.equals(localInputs[i]));
 const isV12=sha(historicalInputs[0])==='94d8e7769bd4c9626aba821cf41deea0b41f8fe1461a3ac55f3bcebb3e21faf1'
  &&sha(historicalInputs[1])==='fe1443fdbb01760720d1e7630a659a7fd6366e72d3216ca39672ad8ca8c588db';
 assert(isCurrent||isV12,'Controller planning inputs differ from this planner: unknown policy/profile');
 const policyVersion=isCurrent?CI_POLICY:'aihr-staging-ci/v12';
 const profile=JSON.parse(historicalInputs[1]),durations=validateDurationHints(profile);
 const execution={...CI_EXECUTION,scheduling:{...CI_EXECUTION.scheduling,hintsSha256:sha(historicalInputs[1]),unknownDurationMs:profile.unknownDurationMs}};
 const tree=git('rev-parse',candidate+'^{tree}');
 const records=execFileSync('git',['-C',repository,'ls-tree','-rz','--full-tree',candidate],{maxBuffer:32*1024**2}).toString('utf8').split('\0').filter(Boolean);
 const selected=[];
 for(const row of records){
  const match=/^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);assert(match,'Malformed Git tree');
  const [,mode,type,id,path]=match;
  assert(safe(path),'Unsafe tracked source path');
  if(type!=='blob'||!['100644','100755'].includes(mode)){assert(!relevant.test(path),'Nonregular coverage source');continue;}
  selected.push({path,id});
 }
 assert(selected.length>0&&selected.length<=100000,'Bounded nonempty source inventory required');
 const ids=[...new Set(selected.map(r=>r.id))];
 const child=spawnSync('git',['-C',repository,'cat-file','--batch'],{input:ids.join('\n')+'\n',maxBuffer:256*1024**2,timeout:60000});
 assert(!child.error&&child.status===0&&Buffer.isBuffer(child.stdout),'Immutable blob read failed');
 const blobs=new Map();let offset=0;
 for(const id of ids){
  const end=child.stdout.indexOf(10,offset);assert(end>=offset,'Missing blob header');
  const header=child.stdout.subarray(offset,end).toString('ascii');const match=/^([a-f0-9]{40}) blob (\d+)$/.exec(header);
  assert(match&&match[1]===id,'Blob identity/type differs');const size=Number(match[2]);
  assert(Number.isSafeInteger(size)&&size<=16*1024**2&&end+1+size<child.stdout.length,'Blob size exceeds boundary');
  const bytes=child.stdout.subarray(end+1,end+1+size);assert(child.stdout[end+1+size]===10,'Truncated blob');
  blobs.set(id,bytes);offset=end+size+2;
 }
 assert(offset===child.stdout.length,'Unexpected trailing blob bytes');
 const source=new Map(selected.map(r=>[r.path,blobs.get(r.id)]));
 const suite=[...source.keys()].filter(p=>/^test\//.test(p)&&/\.test\.ts$|\.dom\.test\.tsx$/.test(p)).sort();
 const browser=[...source.keys()].filter(p=>/^test\//.test(p)&&p.endsWith('.browser.test.tsx')).sort();
 const classified=classifyTestFiles(suite,p=>source.get(p)?.toString('utf8')??null);
 const groups={db:classified.db,nodb:classified.nodb};
 const pdfTooling=classifyPdfToolSources([...source].filter(([path])=>relevant.test(path)).map(([path,bytes])=>({path,bytes})));
 const normalUnits=buildUnits(suite,groups,browser);
 const dbUnits=balanceDatabaseFiles(groups.db,DB_BATCH_FILES,durations,profile.unknownDurationMs).map(files=>({id:'db-'+hash(files).slice(0,16),kind:'db',files,pdfTools:false}));
 const units=[...normalUnits.filter(u=>u.kind==='nodb'),...dbUnits,...normalUnits.filter(u=>u.kind==='browser')];
 const body={schemaVersion:2,policyVersion,sha:candidate,controller,migrationBase:baseline,runtime,execution,pdfTooling,suite,units};
 return {plan:{...body,fingerprint:hash(body)},binding:{candidate,tree,controller,baseline,source:'IMMUTABLE_GIT_BLOBS',candidateCodeExecuted:false}};
}
