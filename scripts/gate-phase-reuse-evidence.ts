/** ADR-0139: exact-commit repair gate with independently rechecked phase provenance. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {databaseWitness,digest,passedPhase,PHASE_REUSE_POLICY_VERSION} from './gate-phase-reuse';
import {git,isAncestor,environmentHash,sourceFiles} from './gate-impact-git';
import {classifyTestFiles} from './gate-db-classify';
import {collectChanges} from './gate-tier-git';
import {planImpact} from './gate-impact';
import {releaseHistory,learningDirectory} from './gate-learning';

export const HOME_REPAIR={path:'test/employee-home-landing.test.ts',before:'25e5c3c719b55a70b28a86c8e5b0381c71b45113f74464bd4bf7db8ea6035528',after:'8cb53750d0b79d61cfbf377808a9fe852114c2d41813cb611deb14c83943ab1e'};
// This is a deliberately bounded initial machinery bootstrap, not permission for arbitrary tests,
// helpers, runtime or configuration changes. Later work outside this contract requires the full gate.
export const BOOTSTRAP_FILES=[
 'scripts/gate-phase-reuse.ts','scripts/gate-phase-reuse-evidence.ts','scripts/gate-phase-reuse-run.ts',
 'scripts/gate.sh','scripts/gate-impact.ts','scripts/gate-learning.ts',
 'scripts/improve/release-gate.ts','scripts/improve/release.ts',
 'test/gate-phase-reuse.test.ts','test/release-phase-reuse.test.ts',
 'docs/adr/0139-counted-database-phase-reuse.md','docs/adr/README.md',
];
export const BASELINE_ARTIFACTS=['plan.json','learning.json','all-files.txt','db-files.txt','nodb-files.txt','classify.tsv','full-controller.log','nodb.log',...Array.from({length:8},(_,i)=>`chunk${i+1}.log`),'port-handover-result.json','fixture-5433-before.json','fixture-5433-after.json','verify-local-fullgate-5433.py','impact-gate-5433.log'];
export type Artifact={path:string;sha256:string};
export type PhaseRun={files:string[];log:string;exit:number};
export type PhaseReuseReceipt={sha:string;result:string;tier:'phase-reuse';base:string;deployedBase:string;environmentHash:string;policyVersion:number;at:string;archive:string;artifacts:Artifact[];nodb:PhaseRun;database:PhaseRun[];planFingerprint:string};
export function proof(ok:unknown,why:string):asserts ok {if(!ok)throw Error('Phase reuse refused: '+why);}
const equal=(a:unknown,b:unknown)=>isDeepStrictEqual(a,b);
export const inventory=(files:Iterable<string>)=>[...files].filter(p=>/^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(p)).sort();
export function trackedTree(ref:string,cwd:string):Map<string,string>{
 const entries=execFileSync('git',['ls-tree','-r','--name-only','-z',ref],{cwd,encoding:'utf8',maxBuffer:128*1024*1024}).split('\0').filter(Boolean);
 const out=new Map<string,string>();
 // Git blob IDs bind every tracked byte, including non-code files. Text is read separately only
 // for parsing/classification, so a binary or unknown extension cannot disappear from the delta.
 for(const line of git(['ls-tree','-r',ref],cwd).split('\n')){const m=/^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(line);proof(m,'invalid git tree');out.set(m[2],m[1]);}
 proof(out.size===entries.length,'unsupported quoted file path');return out;
}
function textAt(ref:string,path:string,cwd:string){return execFileSync('git',['show',`${ref}:${path}`],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:128*1024*1024});}
/** One bounded git plumbing call avoids a subprocess per imported test/helper. */
function committedTexts(ref:string,cwd:string):Map<string,string>{
 const tree=git(['ls-tree','-r',ref],cwd).split('\n').map(line=>/^\d+ \w+ ([0-9a-f]+)\t(.+)$/.exec(line)).filter(m=>m&&/\.(?:[cm]?[jt]sx?|json|css)$/.test(m[2]));
 const ids=[...new Set(tree.map(m=>m![1]))];
 const output=execFileSync('git',['cat-file','--batch'],{cwd,input:ids.join('\n')+'\n',maxBuffer:128*1024*1024});
 const blobs=new Map<string,string>();let offset=0;
 for(const id of ids){const end=output.indexOf(10,offset);proof(end>=offset,'incomplete git blob header');const header=output.subarray(offset,end).toString('utf8').split(' '),size=Number(header[2]);proof(header[0]===id&&header[1]==='blob'&&Number.isSafeInteger(size)&&size>=0,'invalid git blob');offset=end+1;proof(offset+size<output.length&&output[offset+size]===10,'incomplete git blob');blobs.set(id,output.subarray(offset,offset+size).toString('utf8'));offset+=size+1;}
 proof(offset===output.length,'unexpected git batch suffix');return new Map(tree.map(m=>[m![2],blobs.get(m![1])!]));
}
function safeFile(root:string,path:string){
 proof(isAbsolute(root)&&resolve(root)===root,'archive must be an absolute canonical directory');
 proof(/^[a-zA-Z0-9._-]+$/.test(path),'unsafe archive entry');
 proof(lstatSync(root).isDirectory()&&!lstatSync(root).isSymbolicLink(),'archive directory type');
 const file=join(root,path),stat=lstatSync(file);proof(stat.isFile()&&!stat.isSymbolicLink(),'artifact must be a regular file');
 return readFileSync(file);
}
export function artifactManifest(root:string,names:string[]):Artifact[]{return names.map(path=>({path,sha256:digest(safeFile(root,path))})).sort((a,b)=>a.path.localeCompare(b.path));}
export function readArtifacts(root:string,manifest:Artifact[]):Map<string,string>{
 proof(Array.isArray(manifest)&&manifest.length>0,'missing manifest');
 proof(new Set(manifest.map(x=>x.path)).size===manifest.length,'duplicate artifact');
 const out=new Map<string,string>();for(const x of manifest){proof(/^[a-f0-9]{64}$/.test(x.sha256),'invalid artifact hash');const b=safeFile(root,x.path);proof(digest(b)===x.sha256,'tampered '+x.path);out.set(x.path,b.toString('utf8'));}return out;
}
export function validateRepairDelta(base:string,head:string,cwd:string){
 const before=trackedTree(base,cwd),after=trackedTree(head,cwd),allowed=new Set([...BOOTSTRAP_FILES,HOME_REPAIR.path]);
 const changed=[...new Set([...before.keys(),...after.keys()])].filter(p=>before.get(p)!==after.get(p)).sort();
 proof(changed.includes(HOME_REPAIR.path),'the exact test fixture repair is required');
 for(const path of changed){proof(allowed.has(path),'unapproved product/configuration/helper/test delta: '+path);proof(after.has(path),'file removal: '+path);}
 proof(digest(textAt(base,HOME_REPAIR.path,cwd))===HOME_REPAIR.before&&digest(textAt(head,HOME_REPAIR.path,cwd))===HOME_REPAIR.after,'Home fixture is not the reviewed additive repair');
 proof(BOOTSTRAP_FILES.every(p=>after.has(p)),'incomplete verification bootstrap');return changed;
}
export function validateBaseline(artifacts:Map<string,string>,base:string,cwd:string,now=Date.now()){
 proof(/^[a-f0-9]{40}$/.test(base),'baseline must be an exact commit');
 const read=(name:string)=>{const x=artifacts.get(name);proof(x!==undefined,'missing baseline artifact '+name);return x;};
 const plan=JSON.parse(read('plan.json')),learning=JSON.parse(read('learning.json'));
 proof(plan.sha===base&&learning.sha===base&&learning.tier==='full'&&learning.result==='FAIL'&&learning.fullReceipt?.result===learning.result,'baseline identity/result');
 proof(plan.base===plan.deployed&&learning.base===plan.deployed&&plan.environmentHash===learning.environmentHash,'baseline provenance');
 proof(equal(learning.failed,[HOME_REPAIR.path]),'baseline failure outside the allowed Home fixture');
 proof(equal(plan.plan,learning.plan),'original plan differs from learning');
 proof(typeof learning.id==='string'&&/^[a-zA-Z0-9.-]+$/.test(learning.id),'invalid original observation ID');
 proof(equal(JSON.parse(readFileSync(join(learningDirectory(),'gates',learning.id+'.json'),'utf8')),learning),'original append-only observation differs');
 const at=Date.parse(learning.at);proof(Number.isFinite(at)&&now>=at&&now-at<7*86400000,'expired or future baseline');
 const list=(name:string)=>read(name).trim().split('\n');
 const all=list('all-files.txt'),db=list('db-files.txt'),nodb=list('nodb-files.txt');
 proof(equal(all,inventory(trackedTree(base,cwd).keys())),'baseline whole inventory does not match committed source');
 const committed=committedTexts(base,cwd);const baselineRead=(p:string)=>committed.get(p)??null;
 const classified=classifyTestFiles(all,baselineRead);
 proof(equal(classified.db,db)&&equal(classified.nodb,nodb),'baseline classification mismatch');
 const tsv=read('classify.tsv').trim().split('\n').map(line=>line.split('\t').slice(0,2).join('\t')).sort();
 proof(equal(tsv,[...db.map(p=>'DB\t'+p),...nodb.map(p=>'NODB\t'+p)].sort()),'classification artifact is not an exact partition');
 const counted=databaseWitness({chunks:8,databaseFiles:db,noDatabaseFiles:nodb,allFiles:all,baseline:base,fullReceipt:learning.fullReceipt,controllerLog:read('full-controller.log'),chunkLogs:Array.from({length:8},(_,i)=>read(`chunk${i+1}.log`))});
 const failed=read('nodb.log').replace(/\u001b\[[0-9;]*m/g,'');
 proof(/^\s*Test Files\s+1 failed \| 947 passed \(948\)\s*$/m.test(failed)&&/^\s*Tests\s+3 failed \| 12338 passed \(12341\)\s*$/m.test(failed),'baseline no-DB failure shape changed');
 proof([...failed.matchAll(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(test\/\S+)/gm)].every(m=>m[1]===HOME_REPAIR.path),'foreign no-DB failure');
 proof([...failed.matchAll(/^\s*Test Files\s+/gm)].length===1&&[...failed.matchAll(/^\s*Tests\s+/gm)].length===1&&/^\s*Duration\s+\S/m.test(failed)&&!/^\s*Unhandled\s/m.test(failed),'incomplete baseline no-DB footer');
 const restored=JSON.parse(read('port-handover-result.json'));
 proof(restored.candidate===base&&restored.gateExit===1&&restored.nextBuildExit===null&&restored.currentOwnedFixtureClusterRestoredAndLogicallyUnchanged===true&&restored.productionChanged===false,'fixture restoration not verified');
 proof(equal(JSON.parse(read('fixture-5433-before.json')),JSON.parse(read('fixture-5433-after.json'))),'fixture logical comparison changed');
 proof(read('impact-gate-5433.log').includes(base.slice(0,7)),'missing original gate source binding');
 return {plan,learning,all,db,nodb,counted};
}
/** Use the same old/new module graph, including every source reader and uncertain consumer. */
export function phaseReusePlan(base:string,head:string,cwd:string){
 const changed=validateRepairDelta(base,head,cwd),files=sourceFiles(cwd),all=inventory(files.keys());
 const classified=classifyTestFiles(all,p=>files.get(p)??null);
 const impact=planImpact(collectChanges(base,head,cwd),files,[],undefined,true);
 const dbSet=new Set(classified.db),affected=impact.run.filter(p=>dbSet.has(p));
 return {changed,all,nodb:classified.nodb,db:classified.db,affected,impact};
}
export function validatePhaseReuse(receipt:PhaseReuseReceipt,ctx:{head:string;deployedRef:string;worktree:string;now?:number}){
 const {head,deployedRef,worktree:cwd}=ctx,now=ctx.now??Date.now();
 proof(receipt.sha===head&&git(['rev-parse','HEAD'],cwd)===head&&!git(['status','--porcelain'],cwd),'stale HEAD or dirty candidate');
 proof(receipt.tier==='phase-reuse'&&receipt.result==='PASS'&&receipt.policyVersion===PHASE_REUSE_POLICY_VERSION,'receipt tier/result/policy');
 proof(receipt.environmentHash===environmentHash(cwd),'environment changed');
 proof(receipt.deployedBase===deployedRef&&isAncestor(deployedRef,receipt.base,cwd)&&isAncestor(receipt.base,head,cwd),'production moved or ancestry invalid');
 const artifacts=readArtifacts(receipt.archive,receipt.artifacts),base=validateBaseline(artifacts,receipt.base,cwd,now);
 proof(BASELINE_ARTIFACTS.every(p=>artifacts.has(p)),'missing baseline provenance');
 proof(base.plan.deployed===deployedRef&&base.plan.environmentHash===receipt.environmentHash,'original environment/production mismatch');
 proof(new Set(releaseHistory().filter(r=>r.at>base.learning.at).map(r=>r.sha)).size<10,'release interval exceeded');
 const fresh=JSON.parse(artifacts.get('fresh-port-handover-result.json')??'null');
 proof(fresh?.candidate===head&&fresh?.gateExit===0&&fresh?.currentOwnedFixtureClusterRestoredAndLogicallyUnchanged===true&&fresh?.productionChanged===false,'fresh fixture restoration not verified');
 proof(equal(JSON.parse(artifacts.get('fresh-fixture-5433-before.json')??'null'),JSON.parse(artifacts.get('fresh-fixture-5433-after.json')??'null'))&&artifacts.has('fresh-fixture-5433-before.json')&&artifacts.has('fresh-fixture-5433-after.json'),'fresh fixture comparison missing/changed');
 const plan=phaseReusePlan(receipt.base,head,cwd);
 proof(equal(base.db,plan.db),'DB inventory/partition changed');
 proof(receipt.planFingerprint===plan.impact.fingerprint,'impact graph changed');
 const verifyRun=(run:PhaseRun,expected:string[])=>{
  proof(run&&run.exit===0&&equal(run.files,expected),'missing, failed or incorrect fresh coverage');
  const log=artifacts.get(run.log);proof(log!==undefined,'missing fresh log');return passedPhase(log,expected.length);
 };
 proof(receipt.nodb.log==='fresh-nodb.log','incorrect fresh no-DB log identity');
 const freshNodb=verifyRun(receipt.nodb,plan.nodb);
 const expectedBatches=Array.from({length:Math.ceil(plan.affected.length/64)},(_,i)=>plan.affected.slice(i*64,(i+1)*64));
 proof(receipt.database.length===expectedBatches.length,'missing/duplicate fresh DB batches');
 const logNames=[receipt.nodb.log,...receipt.database.map(r=>r.log)];proof(new Set(logNames).size===logNames.length,'duplicate fresh log');
 for(let i=0;i<expectedBatches.length;i++){proof(receipt.database[i].log===`fresh-db-${i+1}.log`,'incorrect fresh DB log identity');verifyRun(receipt.database[i],expectedBatches[i]);}
 return {plan,base,freshNodb};
}
