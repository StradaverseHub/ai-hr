/** ADR-0133: write-once per-unit checkpoints that let an impact gate resume without proving less. */
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImpactPlan } from './gate-impact';
import { classifyTestFiles } from './gate-db-classify';
import { learningDirectory } from './gate-learning';

export const DB_BATCH=64;
export type UnitKind='nodb'|'db'|'browser';
export type Unit={id:string;kind:UnitKind;index:number;files:string[]};
export type CoverageBody={schemaVersion:1;sha:string;base:string;deployed:string;environmentHash:string;policyVersion:number;tier:'impact';run:string[];browser:boolean;units:Unit[]};
export type Checkpoint={schemaVersion:1;kind:'gate-checkpoint';id:string;attempt:string;coverageId:string;sha:string;treeClean:true;
 environmentHash:string;policyVersion:number;planFingerprint:string;planHash:string;unit:string;unitKind:UnitKind;index:number;unitCount:number;
 files:string[];filesHash:string;startedAt:string;endedAt:string;exitCode:number;asked:number;counted:number|null;summaryFailed:boolean;passed:boolean;log:string;logSha256:string};
export type CheckpointRef={unit:string;id:string;sha256:string};
export type ReceiptCheckpoints={coverageId:string;units:CheckpointRef[];attempts:{unit:string;id:string;passed:boolean}[];assembled:boolean};

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const isSha=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{40}$/.test(s);
const safe=(s:string)=>/^[a-zA-Z0-9.-]+$/.test(s);
const same=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every((x,i)=>x===b[i]);

/** The exact partition the runner executes: no-DB as one unit, DB in 64-file batches in plan order, then browser. */
export function unitsFor(plan:Pick<ImpactPlan,'run'|'browser'>,read:(p:string)=>string|null,browserFiles:string[]):Unit[]{
 const {db,nodb}=classifyTestFiles(plan.run,read),units:Unit[]=[];
 if(nodb.length)units.push({id:'nodb',kind:'nodb',index:units.length,files:nodb});
 for(let offset=0;offset<db.length;offset+=DB_BATCH)units.push({id:'db-'+String(offset/DB_BATCH+1).padStart(3,'0'),kind:'db',index:units.length,files:db.slice(offset,offset+DB_BATCH)});
 if(plan.browser)units.push({id:'browser',kind:'browser',index:units.length,files:[...browserFiles].sort()});
 return units;
}
export function coverageBody(p:Omit<CoverageBody,'schemaVersion'|'tier'>&{tier:string}):CoverageBody{
 if(p.tier!=='impact')throw Error('Only an impact plan has resumable units; the full tier runs uninterrupted');
 if(!isSha(p.sha)||!isSha(p.base)||!isSha(p.deployed))throw Error('Coverage requires exact commits');
 return {schemaVersion:1,sha:p.sha,base:p.base,deployed:p.deployed,environmentHash:p.environmentHash,policyVersion:p.policyVersion,tier:'impact',run:p.run,browser:p.browser,units:p.units};
}
export const coverageId=(body:CoverageBody)=>digest(JSON.stringify(body));
const coverageDir=(directory:string,sha:string,id:string)=>{if(!isSha(sha)||!/^[0-9a-f]{64}$/.test(id))throw Error('Invalid checkpoint coverage');return join(directory,'checkpoints',sha,id);};

/** Vitest's final "Test Files" line; the same parse the runner has always used to count. */
export function summarize(log:string):{counted:number|null;failed:boolean}{
 const line=log.match(/^\s*Test Files[^\n]*\((\d+)\)\s*$/gm)?.at(-1);if(!line)return {counted:null,failed:true};
 const n=Number(line.match(/\((\d+)\)\s*$/)?.[1]);return {counted:Number.isInteger(n)?n:null,failed:/\bfailed\b/.test(line)};
}

function writeOnce(path:string,bytes:string|Buffer){
 if(existsSync(path))throw Error('Checkpoint evidence cannot be overwritten: '+path);
 const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});renameSync(tmp,path);
}
/** Called only after the runner re-proved the candidate frozen (same HEAD, clean tree). */
export function saveCheckpoint(p:{body:CoverageBody;unit:Unit;attempt:string;planFingerprint:string;planHash:string;startedAt:string;endedAt:string;exitCode:number;logBytes:Buffer},directory=learningDirectory()):{checkpoint:Checkpoint;ref:CheckpointRef}{
 if(!safe(p.attempt)||!safe(p.unit.id))throw Error('Invalid checkpoint identity');
 const id=coverageId(p.body),dir=coverageDir(directory,p.body.sha,id);mkdirSync(dir,{recursive:true,mode:0o700});
 const coverage=join(dir,'coverage.json'),coverageBytes=JSON.stringify(p.body,null,2)+'\n';
 if(!existsSync(coverage))writeOnce(coverage,coverageBytes);else if(readFileSync(coverage,'utf8')!==coverageBytes)throw Error('Coverage record does not match its identity');
 const name=p.unit.id+'.'+p.attempt,{counted,failed}=summarize(p.logBytes.toString('utf8'));
 writeOnce(join(dir,name+'.log'),p.logBytes);
 const checkpoint:Checkpoint={schemaVersion:1,kind:'gate-checkpoint',id:name,attempt:p.attempt,coverageId:id,sha:p.body.sha,treeClean:true,
  environmentHash:p.body.environmentHash,policyVersion:p.body.policyVersion,planFingerprint:p.planFingerprint,planHash:p.planHash,
  unit:p.unit.id,unitKind:p.unit.kind,index:p.unit.index,unitCount:p.body.units.length,files:p.unit.files,filesHash:digest(JSON.stringify(p.unit.files)),
  startedAt:p.startedAt,endedAt:p.endedAt,exitCode:p.exitCode,asked:p.unit.files.length,counted,summaryFailed:failed,
  passed:p.exitCode===0&&counted===p.unit.files.length&&!failed,log:name+'.log',logSha256:digest(p.logBytes)};
 const bytes=JSON.stringify(checkpoint,null,2)+'\n';writeOnce(join(dir,name+'.json'),bytes);
 return {checkpoint,ref:{unit:p.unit.id,id:name,sha256:digest(bytes)}};
}

/** The single verification used by resume and by release. Returns why it is not green evidence, or null. */
export function verifyCheckpoint(ref:CheckpointRef,body:CoverageBody,directory=learningDirectory()):string|null{
 if(!safe(ref.id)||!safe(ref.unit))return 'invalid checkpoint reference';
 const id=coverageId(body),dir=coverageDir(directory,body.sha,id),unit=body.units.find(u=>u.id===ref.unit);
 if(!unit)return `unit ${ref.unit} is not part of this coverage`;
 const path=join(dir,ref.id+'.json');if(!existsSync(path))return `checkpoint ${ref.id} is missing`;
 const bytes=readFileSync(path);if(digest(bytes)!==ref.sha256)return `checkpoint ${ref.id} was altered`;
 let c:Checkpoint;try{c=JSON.parse(bytes.toString('utf8'));}catch{return `checkpoint ${ref.id} is unreadable`;}
 if(c.schemaVersion!==1||c.kind!=='gate-checkpoint'||c.id!==ref.id||c.unit!==ref.unit||c.treeClean!==true)return `checkpoint ${ref.id} has the wrong identity`;
 if(c.sha!==body.sha||c.coverageId!==id||c.environmentHash!==body.environmentHash||c.policyVersion!==body.policyVersion)return `checkpoint ${ref.id} covers another commit, environment or policy`;
 if(c.unitKind!==unit.kind||c.index!==unit.index||c.unitCount!==body.units.length||!Array.isArray(c.files)||!same(c.files,unit.files)||c.filesHash!==digest(JSON.stringify(unit.files)))return `checkpoint ${ref.id} ran a different file list`;
 if(c.passed!==true||c.exitCode!==0||c.asked!==unit.files.length||c.counted!==unit.files.length||c.summaryFailed!==false)return `checkpoint ${ref.id} is not green`;
 if(c.log!==ref.id+'.log'||!existsSync(join(dir,c.log)))return `checkpoint ${ref.id} has no log`;
 const log=readFileSync(join(dir,c.log));if(digest(log)!==c.logSha256)return `checkpoint ${ref.id} log was altered`;
 const s=summarize(log.toString('utf8'));if(s.counted!==unit.files.length||s.failed)return `checkpoint ${ref.id} log does not count ${unit.files.length} passing files`;
 return null;
}
const refFor=(path:string,unit:string,id:string):CheckpointRef=>({unit,id,sha256:digest(readFileSync(path))});

/** Every checkpoint saved for this exact coverage, oldest first; verification decides which are evidence. */
export function existingCheckpoints(body:CoverageBody,directory=learningDirectory()):{ref:CheckpointRef;checkpoint:Checkpoint}[]{
 const dir=coverageDir(directory,body.sha,coverageId(body));if(!existsSync(dir))return [];
 return readdirSync(dir).filter(p=>p.endsWith('.json')&&p!=='coverage.json'&&safe(p.slice(0,-5))).flatMap(p=>{
  try{const checkpoint=JSON.parse(readFileSync(join(dir,p),'utf8')) as Checkpoint;if(checkpoint.id!==p.slice(0,-5))return [];
   return [{ref:refFor(join(dir,p),checkpoint.unit,checkpoint.id),checkpoint}];}catch{return [];}
 }).sort((a,b)=>String(a.checkpoint.endedAt).localeCompare(String(b.checkpoint.endedAt))||a.ref.id.localeCompare(b.ref.id));
}
/** Coverage identities already holding checkpoints for this commit: what --resume reports when it refuses. */
export function coveragesFor(sha:string,directory=learningDirectory()):CoverageBody[]{
 if(!isSha(sha))return [];const root=join(directory,'checkpoints',sha);if(!existsSync(root))return [];
 return readdirSync(root).filter(p=>existsSync(join(root,p,'coverage.json'))).map(p=>JSON.parse(readFileSync(join(root,p,'coverage.json'),'utf8')) as CoverageBody);
}
export function describeMismatch(want:CoverageBody,have:CoverageBody):string[]{
 const out:string[]=[];
 for(const k of ['base','deployed','environmentHash','policyVersion','browser'] as const)if(want[k]!==have[k])out.push(`${k} ${String(have[k]).slice(0,12)} → ${String(want[k]).slice(0,12)}`);
 if(!same(want.run,have.run))out.push(`selected run ${have.run.length} → ${want.run.length} files`);
 else if(JSON.stringify(want.units)!==JSON.stringify(have.units))out.push('unit partition changed');
 return out;
}

export type Execution={exitCode:number;logBytes:Buffer;startedAt:string;endedAt:string};
/**
 * Run the units of one attempt. Without resume every unit runs. With resume a unit is skipped only when
 * a checkpoint for this exact coverage verifies green; a unit with only red checkpoints always reruns.
 */
export function runAttempt(p:{body:CoverageBody;resume:boolean;attempt:string;planFingerprint:string;planHash:string;execute:(unit:Unit)=>Execution;afterExecute?:()=>void;log?:(line:string)=>void},directory=learningDirectory()):{passed:boolean;checkpoints:ReceiptCheckpoints;executed:Unit[]}{
 const say=p.log??(()=>{}),reuse=new Map<string,CheckpointRef>(),attempts:ReceiptCheckpoints['attempts']=[];
 if(p.resume){
  const prior=existingCheckpoints(p.body,directory);
  if(!prior.length)throw Error('--resume: no checkpoints exist for this exact coverage');
  for(const {ref,checkpoint}of prior){
   attempts.push({unit:ref.unit,id:ref.id,passed:checkpoint.passed===true});
   const why=verifyCheckpoint(ref,p.body,directory);
   if(why===null)reuse.set(ref.unit,ref);else if(checkpoint.passed===true)say(`  ✗ not reused: ${why}`);
  }
 }
 const units:CheckpointRef[]=[],executed:Unit[]=[];let passed=true;
 for(const unit of p.body.units){
  const prior=reuse.get(unit.id);
  if(prior){say(`REUSE ${unit.id} (${unit.files.length} files) from ${prior.id}`);units.push(prior);continue;}
  const run=p.execute(unit);p.afterExecute?.();executed.push(unit);
  const saved=saveCheckpoint({body:p.body,unit,attempt:p.attempt,planFingerprint:p.planFingerprint,planHash:p.planHash,...run},directory);
  attempts.push({unit:unit.id,id:saved.ref.id,passed:saved.checkpoint.passed});
  if(saved.checkpoint.passed&&verifyCheckpoint(saved.ref,p.body,directory)===null)units.push(saved.ref);else passed=false;
 }
 if(units.length!==p.body.units.length)passed=false;
 return {passed,executed,checkpoints:{coverageId:coverageId(p.body),units,attempts,assembled:units.some(r=>!r.id.endsWith('.'+p.attempt))}};
}

/** Release-time and resume-time proof that a receipt's checkpoints cover every unit of this coverage. */
export function verifyReceiptCheckpoints(c:ReceiptCheckpoints|undefined,body:CoverageBody,directory=learningDirectory()):string|null{
 if(!c||!Array.isArray(c.units))return 'lists no unit checkpoints';
 if(c.coverageId!==coverageId(body))return 'checkpoints describe a different commit, selection, partition or environment';
 if(c.units.length!==body.units.length||new Set(c.units.map(r=>r.unit)).size!==c.units.length)return 'does not list exactly one checkpoint per unit';
 for(const unit of body.units){
  const ref=c.units.find(r=>r.unit===unit.id);if(!ref)return `has no checkpoint for unit ${unit.id}`;
  const why=verifyCheckpoint(ref,body,directory);if(why)return why;
 }
 return null;
}
