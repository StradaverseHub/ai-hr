/** Persistent, append-only verification/release evidence; contains code metadata, never HR records. */
import { createHash,randomUUID } from 'node:crypto';
import { mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync,existsSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ImpactPlan,Classification,LearnedFailure } from './gate-impact';
export type GateObservation={schemaVersion:1;id:string;at:string;sha:string;base:string;environmentHash:string;result:'PASS'|'FAIL';tier:'full'|'impact';plan:ImpactPlan;failed:string[];wallSeconds:number;fullReceipt?:Record<string,unknown>;executed?:string[]};
export type ReleaseObservation={schemaVersion:1;id:string;at:string;sha:string;buildId:string;deploymentState:'built';activeServiceVerified:false;gate:GateObservation|null;classifications:Classification[];transitions:{path:string;from:string;to:string;reason:string}[];unknowns:Classification[]};
export const learningDirectory=()=>process.env.AIHR_IMPACT_STATE_DIR??join(homedir(),'.aihr-gate-state','impact-learning');
const sha=(s:unknown)=>typeof s==='string'&&/^[0-9a-f]{40}$/.test(s);
function releaseIdentity(shaValue:string,buildId:string):string{
 if(!sha(shaValue)||typeof buildId!=='string'||!buildId||buildId.length>200)throw Error('Invalid release identity');
 return shaValue+'.'+createHash('sha256').update(buildId).digest('hex').slice(0,16);
}
function* records<T>(directory:string,kind:'gates'|'releases'):Generator<T>{
 const root=join(directory,kind);if(!existsSync(root))return;
 for(const p of readdirSync(root).filter(p=>/^[a-zA-Z0-9.-]+\.json$/.test(p)).sort()){
  const record=JSON.parse(readFileSync(join(root,p),'utf8'));
  if(record.schemaVersion!==1||!sha(record.sha)||typeof record.id!=='string'||typeof record.at!=='string')throw Error('Invalid saved verification evidence: '+p);
  yield record as T;
 }
}
function readRecords<T>(directory:string,kind:'gates'|'releases'):T[]{
 let recent:T[]=[];
 for(const record of records<T>(directory,kind)){recent.push(record);recent.sort((a,b)=>(a as {at:string}).at.localeCompare((b as {at:string}).at));if(recent.length>200)recent.shift();}
 return recent;
}
function persist(directory:string,kind:'gates'|'releases',record:{id:string}){
 if(!/^[a-zA-Z0-9.-]+$/.test(record.id))throw Error('Invalid evidence identifier');
 const root=join(directory,kind);mkdirSync(root,{recursive:true,mode:0o700});const path=join(root,record.id+'.json');
 const bytes=JSON.stringify(record,null,2)+'\n';
 if(existsSync(path)){if(readFileSync(path,'utf8')!==bytes)throw Error('Evidence cannot be overwritten');return;}
 const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,bytes,{mode:0o600,flag:'wx'});renameSync(tmp,path);
}
export function gateHistory(directory=learningDirectory()):GateObservation[]{return readRecords(directory,'gates');}
export function releaseHistory(directory=learningDirectory()):ReleaseObservation[]{return readRecords(directory,'releases');}
export function failureHistory(directory=learningDirectory()):LearnedFailure[]{
 const failures=new Map<string,Set<string>>();
 for(const r of records<GateObservation>(directory,'gates'))if(r.result==='FAIL')for(const path of r.plan.changed){const tests=failures.get(path)??new Set<string>();for(const test of r.failed)tests.add(test);failures.set(path,tests);}
 return [...failures].map(([path,tests])=>({changed:[path],failed:[...tests].sort()}));
}
export function saveGate(observation:Omit<GateObservation,'id'|'schemaVersion'|'at'>,directory=learningDirectory()):GateObservation{
 if(!sha(observation.sha)||!sha(observation.base))throw Error('Gate evidence requires exact commits');
 const record:GateObservation={...observation,schemaVersion:1,at:new Date().toISOString(),id:observation.sha+'.'+randomUUID()};persist(directory,'gates',record);return record;
}
export function saveRelease(input:{sha:string;buildId:string;gate:GateObservation|null;classifications:Classification[]},directory=learningDirectory()):ReleaseObservation{
 const id=releaseIdentity(input.sha,input.buildId),existingPath=join(directory,'releases',id+'.json');
 if(existsSync(existingPath)){
  const existing=JSON.parse(readFileSync(existingPath,'utf8')) as ReleaseObservation;
  if(existing.schemaVersion!==1||existing.sha!==input.sha||existing.buildId!==input.buildId)throw Error('Invalid saved release identity');
  return existing;
 }
 const prior=new Map(riskKnowledge(directory).map(r=>[r.classification.path,r.classification]));
 const classifications=input.classifications;
 const transitions=classifications.flatMap(c=>{const before=prior.get(c.path);return before&&before.risk!==c.risk?[{path:c.path,from:before.risk,to:c.risk,reason:c.reason}]:[];});
 const record:ReleaseObservation={schemaVersion:1,id,at:new Date().toISOString(),...input,
  deploymentState:'built',activeServiceVerified:false,transitions,unknowns:classifications.filter(c=>c.risk==='unknown')};
 persist(directory,'releases',record);return record;
}

/** A mirror copies the source fact verbatim. Recreating it would replace its timestamp/transitions
 * with receive-time state and could let an old retry overwrite newer classification knowledge. */
export function saveMirroredRelease(record:ReleaseObservation,directory=learningDirectory()):ReleaseObservation{
 if(record.schemaVersion!==1||record.id!==releaseIdentity(record.sha,record.buildId)
  ||typeof record.at!=='string'||!Number.isFinite(Date.parse(record.at))||new Date(record.at).toISOString()!==record.at
  ||record.deploymentState!=='built'||record.activeServiceVerified!==false
  ||!Array.isArray(record.classifications)||record.classifications.some(c=>!['low','moderate','high','unknown'].includes(c.risk)||typeof c.path!=='string')
  ||!Array.isArray(record.unknowns)||!Array.isArray(record.transitions)||record.gate&&record.gate.sha!==record.sha)throw Error('Invalid mirrored release evidence');
 persist(directory,'releases',record);return record;
}

/** Periodic broad verification complements selection; this is checked at the next gate, not a timer. */
export function fullRegressionDue(gates:GateObservation[],releases:ReleaseObservation[],environmentHash:string,now=Date.now()):string|null{
 const full=gates.filter(g=>g.result==='PASS'&&g.tier==='full'&&g.environmentHash===environmentHash&&g.fullReceipt?.result==='PASS'&&g.fullReceipt?.sha===g.sha&&g.fullReceipt?.tier==='full'&&typeof g.fullReceipt?.files==='number'&&g.fullReceipt.files>0&&g.fullReceipt.files===g.fullReceipt.suiteFiles).at(-1);
 if(!full)return 'first impact-aware run needs a verified full baseline';
 const at=Date.parse(full.at);if(!Number.isFinite(at)||now-at>7*86400000)return 'seven-day full regression interval reached';
 if(new Set(releases.filter(r=>r.at>full.at).map(r=>r.sha)).size>=10)return 'ten released versions since the last full regression';
 return null;
}
export function riskKnowledge(directory=learningDirectory()){
 const paths=new Map<string,{classification:Classification;lastRelease:string;observations:number;at:string}>();
 for(const release of records<ReleaseObservation>(directory,'releases'))for(const classification of release.classifications){
  const prior=paths.get(classification.path);
  const latest=!prior||release.at>=prior.at?{classification,lastRelease:release.sha,at:release.at}:prior;
  paths.set(classification.path,{...latest,observations:(prior?.observations??0)+1});
 }
 return [...paths.values()].sort((a,b)=>a.classification.path.localeCompare(b.classification.path));
}
export function queueReleaseMirror(record:ReleaseObservation,directory=learningDirectory()){
 const root=join(directory,'outbox');mkdirSync(root,{recursive:true,mode:0o700});
 writeFileSync(join(root,record.id+'.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
}
export function pendingReleaseMirrors(directory=learningDirectory()):ReleaseObservation[]{
 const root=join(directory,'outbox');if(!existsSync(root))return [];
 return readdirSync(root).filter(p=>/^[a-zA-Z0-9.-]+\.json$/.test(p)).map(p=>JSON.parse(readFileSync(join(root,p),'utf8')) as ReleaseObservation).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
export function acknowledgeReleaseMirror(record:ReleaseObservation,directory=learningDirectory()){
 if(!/^[a-zA-Z0-9.-]+$/.test(record.id))throw Error('Invalid mirror identity');
 const path=join(directory,'outbox',record.id+'.json');if(existsSync(path))unlinkSync(path);
}
