/** Pure proposed wire grammar. Shape/equality checks confer NO native/source/admission authority. */
export type Engine = 'a' | 'b' | 'c';
export type Purpose = 'semantic' | 'cli-b' | 'cli-c';
export type Verdict = {rootId:number; kind:'DB'|'NODB'; reason:string};
type Obj = Record<string, unknown>;
type Check = (v:unknown)=>void;
const fail = ():never => { throw Error('Classifier witness protocol refused'); };
const need = (v:unknown):void => { if (!v) fail(); };
const object = (v:unknown):Obj => { need(v!==null && typeof v==='object' && !Array.isArray(v) && Object.getPrototypeOf(v)===Object.prototype); return v as Obj; };
const shape = (v:unknown, fields:Record<string,Check>):Obj => {
 const o=object(v); need(JSON.stringify(Object.keys(o).sort())===JSON.stringify(Object.keys(fields).sort()));
 for(const [k,c] of Object.entries(fields)) c(o[k]); return o;
};
const str:Check=v=>need(typeof v==='string');
const text:Check=v=>{str(v);need(!(v as string).includes('\0'));};
const nonempty:Check=v=>{text(v);need((v as string).length>0);};
const uint:Check=v=>need(Number.isSafeInteger(v) && (v as number)>=0);
const positive:Check=v=>{uint(v);need((v as number)>0);};
const bool:Check=v=>need(typeof v==='boolean');
const fixed=(...values:unknown[]):Check=>v=>need(values.includes(v));
const nullable=(c:Check):Check=>v=>{if(v!==null)c(v);};
const list=(c:Check):Check=>v=>{need(Array.isArray(v));for(const x of v as unknown[])c(x);};
const sha:Check=v=>need(typeof v==='string' && /^[a-f0-9]{64}$/.test(v));
const git:Check=v=>need(typeof v==='string' && /^[a-f0-9]{40}$/.test(v));
const decimal:Check=v=>need(typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v));
const engine:Check=fixed('a','b','c');
const purpose:Check=fixed('semantic','cli-b','cli-c');
const kind:Check=fixed('DB','NODB');
const path:Check=v=>{nonempty(v);need(!(v as string).startsWith('/') && !(v as string).split('/').some(s=>s==='.'||s==='..'||s===''));};
const rootPath:Check=v=>{path(v);need(!/\s/.test(v as string));};
const rows=(v:unknown,c:Check):Obj[]=>{list(c)(v);return v as Obj[];};
const ids=(rs:Obj[],key='id'):void=>rs.forEach((r,i)=>need(r[key]===i));
const unique=(vs:unknown[]):void=>need(new Set(vs).size===vs.length);
const same=(a:unknown,b:unknown):void=>need(canonicalJson(a)===canonicalJson(b));
const ordered=(vs:string[]):void=>{unique(vs);same(vs,[...vs].sort());};
const version:Check=fixed(1);
const verdict:Check=v=>{shape(v,{rootId:uint,kind,reason:str});};

/** Sorted JSON keys, exact code units (including escaped control/surrogate strings), one LF. */
export function canonicalJson(value:unknown):string {
 const visit=(v:unknown):unknown=>{
  if(v===null || typeof v==='string' || typeof v==='boolean')return v;
  if(typeof v==='number'){need(Number.isFinite(v) && !Object.is(v,-0));return v;}
  if(Array.isArray(v))return v.map(visit);
  const o=object(v), out:Obj=Object.create(null);for(const k of Object.keys(o).sort())out[k]=visit(o[k]);return out;
 };
 return JSON.stringify(visit(value))+'\n';
}
export function decodeCanonicalJson(raw:string):unknown {
 let v:unknown;try{v=JSON.parse(raw);}catch{fail();}sameRaw(raw,canonicalJson(v));return v;
}
function sameRaw(a:string,b:string):void { need(a===b); }

const COMMON = ['binding.json','anchor.json','prerequisites.json','suite.json','stdin.txt',
 'git-source-head.stdout','git-source-status.stdout','git-source-tracked.bin','git-controller-head.stdout','git-controller-status.stdout',
 'post-git-source-head.stdout','post-git-source-status.stdout','post-git-source-tracked.bin','post-git-controller-head.stdout','post-git-controller-status.stdout',
 'native-ownership.jsonl','report.json'] as const;
export const SEMANTIC_MEMBERS = Object.freeze([...COMMON,'program-a.ts','program-b.ts','program-c.ts','snapshot-index.json',
 'calls-a.json','calls-b.json','calls-c.json','graph.json','reasons.json','semantic-a.tsv','semantic-b.tsv','semantic-c.tsv',
 'delta-a-b.json','delta-a-c.json','delta-b-c.json','phase-collect.json','phase-replay.json','phase-seal.json']);
export const CLI_MEMBERS = Object.freeze([...COMMON,'semantic-parent.json','snapshot-index.json','program.ts','package-context.json',
 'native-clock.json','stdin-stream.json','native.stdout','native.stderr','native-result.json','source-pre.json','source-post.json','phase-parent-auth.json','phase-seal.json']);
const GIT_STAGES=['source-head','source-status','all-tracked','controller-head','controller-status'];
const POST_STAGES=['post-source-head','post-source-status','post-all-tracked','post-controller-head','post-controller-status'];
export function stageNames(p:Purpose):string[]{ return p==='semantic' ? [...GIT_STAGES,'collect','replay',...POST_STAGES,'seal'] : [...GIT_STAGES,'parent-auth','prepare','cli','postimage',...POST_STAGES,'seal']; }
const PRE_MEMBERS=['git-source-head.stdout','git-source-status.stdout','git-source-tracked.bin','git-controller-head.stdout','git-controller-status.stdout'];
const POST_MEMBERS=PRE_MEMBERS.map(x=>'post-'+x);
function stageMembers(p:Purpose):string[][] {
 const pre=PRE_MEMBERS.map(x=>[x]), post=POST_MEMBERS.map(x=>[x]);
 return p==='semantic' ? [...pre,
  ['suite.json','stdin.txt','snapshot-index.json','calls-a.json','calls-b.json','calls-c.json','phase-collect.json'],
  ['graph.json','reasons.json','semantic-a.tsv','semantic-b.tsv','semantic-c.tsv','delta-a-b.json','delta-a-c.json','delta-b-c.json','phase-replay.json'],...post,
  ['native-ownership.jsonl','phase-seal.json']] : [...pre,
  ['semantic-parent.json','snapshot-index.json','phase-parent-auth.json'],
  ['suite.json','stdin.txt','program.ts','package-context.json','source-pre.json'],
  ['native-clock.json','stdin-stream.json','native.stdout','native.stderr','native-result.json'],['source-post.json'],...post,
  ['native-ownership.jsonl','phase-seal.json']];
}
export function memberLimit(name:string):number {
 if(name==='stdin.txt'||name.endsWith('tracked.bin'))return 8*1024*1024;
 if(name.endsWith('.ts')||name.endsWith('.tsv')||name==='snapshot-index.json'||name.startsWith('calls-')||name.startsWith('delta-')||['graph.json','reasons.json','native.stdout','native.stderr','native-ownership.jsonl'].includes(name))return 16*1024*1024;
 return 1024*1024;
}
const reportCheck:Check=v=>{shape(v,{version,kind:fixed('FORMAT_ONLY_NOT_ADMISSION'),purpose,complete:bool,completedStages:list(nonempty),failedStage:nullable(nonempty),failedMembers:list(nonempty)});};
/** Exact complete set, or exact output-prefix of completed stages + failed stage prefix. */
export function validateMemberSet(p:Purpose,names:string[],report:unknown):void {
 reportCheck(report);const r=report as Obj;need(r.purpose===p);unique(names);
 const stages=stageNames(p),done=r.completedStages as string[], failed=r.failedMembers as string[];
 same(done,stages.slice(0,done.length));need(done.length<=stages.length);
 const all=p==='semantic'?SEMANTIC_MEMBERS:CLI_MEMBERS;
 for(const n of names)need(all.includes(n));
 const base=['binding.json','anchor.json','prerequisites.json','report.json',...(p==='semantic'?['program-a.ts','program-b.ts','program-c.ts']:[])];
 const groups=stageMembers(p),expected=[...base,...groups.slice(0,done.length).flat()];
 if(r.complete){need(done.length===stages.length&&r.failedStage===null&&failed.length===0);}
 else {need(done.length<stages.length&&r.failedStage===stages[done.length]);same(failed,groups[done.length].slice(0,failed.length));expected.push(...failed);}
 same([...names].sort(),expected.sort());
}

export type SnapshotRow = {id:number;path:string;firstSeen:number;firstEngine:Engine;value:null|{blob:string;rawSha256:string;rawBytes:number;textSha256:string;textCodeUnits:number;mode:'100644'|'100755'}};
export type Snapshot = {version:1;rows:SnapshotRow[]};
export function validateSnapshot(v:unknown):Snapshot {
 const positiveValue:Check=x=>{shape(x,{blob:git,rawSha256:sha,rawBytes:uint,textSha256:sha,textCodeUnits:uint,mode:fixed('100644','100755')});};
 const o=shape(v,{version,rows:list(x=>{shape(x,{id:uint,path:str,firstSeen:uint,firstEngine:engine,value:nullable(positiveValue)});})});
 const rs=o.rows as SnapshotRow[];ids(rs as unknown as Obj[]);ordered(rs.map(r=>r.path));same(rs.map(r=>r.firstSeen).sort((a,b)=>a-b),rs.map((_,i)=>i));return v as Snapshot;
}
export function validateCalls(v:unknown,snapshot:Snapshot,expected:Engine):void {
 const o=shape(v,{version,engine,rows:list(x=>{shape(x,{id:uint,sourceId:uint});})});need(o.engine===expected);
 const rs=o.rows as Obj[];ids(rs);for(const r of rs)need((r.sourceId as number)<snapshot.rows.length);
}
export function validateSuite(v:unknown):string[]{
 const o=shape(v,{version,paths:list(rootPath)}),paths=o.paths as string[];need(paths.length>0);ordered(paths);return paths;
}
export function validateVerdicts(v:unknown,roots:string[]):Verdict[]{
 const rs=rows(v,verdict);need(rs.length===roots.length);ids(rs,'rootId');return v as Verdict[];
}
/** Semantic TSV is reversible: JSON-string path/reason, never native CLI text. */
export function semanticTsv(roots:string[],values:Verdict[]):string {
 validateSuite({version:1,paths:roots});validateVerdicts(values,roots);
 return values.map(v=>`${v.kind}\t${JSON.stringify(roots[v.rootId])}\t${JSON.stringify(v.reason)}\n`).join('');
}
export function parseSemanticTsv(raw:string,roots:string[]):Verdict[]{
 need(raw.endsWith('\n'));const lines=raw.slice(0,-1).split('\n');need(lines.length===roots.length);
 const values=lines.map((line,i)=>{const fields=line.split('\t');need(fields.length===3);kind(fields[0]);let p:unknown,r:unknown;try{p=JSON.parse(fields[1]);r=JSON.parse(fields[2]);}catch{fail();}need(p===roots[i]);str(r);return{rootId:i,kind:fields[0] as 'DB'|'NODB',reason:r as string};});
 sameRaw(raw,semanticTsv(roots,values));return values;
}
export function validateGraph(v:unknown,snapshot:Snapshot,roots:string[]):void {
 const step:Check=x=>{const o=object(x);if(o.kind==='helper')shape(o,{kind:fixed('helper'),targetId:uint});else shape(o,{kind:fixed('direct'),reason:str});};
 const resolver:Check=x=>{shape(x,{id:uint,nodeId:uint,importIndex:uint,specifier:str,candidates:list(uint),selectedSourceId:nullable(uint),outcome:fixed('bare','missing','resolved')});};
 const o=shape(v,{version,nodes:list(x=>{shape(x,{id:uint,sourceId:uint,steps:list(step)});}),resolvers:list(resolver),hazardous:list(uint)});
 const ns=o.nodes as Obj[],res=o.resolvers as Obj[];ids(ns);ids(res);unique(ns.map(n=>n.sourceId));
 for(const n of ns){need((n.sourceId as number)<snapshot.rows.length);for(const s of n.steps as Obj[])if(s.kind==='helper')need((s.targetId as number)<ns.length);}
 for(const root of roots)need(ns.some(n=>snapshot.rows[n.sourceId as number].path===root));
 let priorNode=-1,priorImport=-1;
 for(const r of res){need((r.nodeId as number)<ns.length);need((r.nodeId as number)>priorNode||r.nodeId===priorNode&&(r.importIndex as number)>priorImport);priorNode=r.nodeId as number;priorImport=r.importIndex as number;
  for(const id of r.candidates as number[])need(id<snapshot.rows.length);
  const selected=r.selectedSourceId as number|null,candidates=r.candidates as number[];
  if(r.outcome==='bare')need(candidates.length===0&&selected===null);
  else if(r.outcome==='missing')need(selected===null&&candidates.every(id=>snapshot.rows[id].value===null));
  else {need(selected!==null&&candidates.length>0&&candidates[candidates.length-1]===selected&&snapshot.rows[selected].value!==null);need(candidates.slice(0,-1).every(id=>snapshot.rows[id].value===null));}
 }
 const hazards=o.hazardous as number[];same(hazards,[...new Set(hazards)].sort((a,b)=>a-b));for(const id of hazards)need(id<ns.length);
}
export function validateReasons(v:unknown,roots:string[],nodeCount:number):Record<Engine,Verdict[]> {
 const witness:Check=x=>{shape(x,{rootId:uint,nodeIds:list(uint),directNodeId:nullable(uint),directStepIndex:nullable(uint)});};
 const o=shape(v,{version,a:list(verdict),b:list(verdict),c:list(verdict),witnesses:list(witness)});
 const a=validateVerdicts(o.a,roots),b=validateVerdicts(o.b,roots),c=validateVerdicts(o.c,roots);same(b,c);
 const ws=o.witnesses as Obj[];need(ws.length===roots.length);ids(ws,'rootId');
 for(const w of ws){const ns=w.nodeIds as number[];unique(ns);for(const id of ns)need(id<nodeCount);
  if(b[w.rootId as number].kind==='NODB')need(ns.length===0&&w.directNodeId===null&&w.directStepIndex===null);
  else {need(ns.length>0&&w.directNodeId===ns[ns.length-1]&&w.directStepIndex!==null);}
 }return{a,b,c};
}
export function deltaRows(before:Verdict[],after:Verdict[]):Obj[]{
 need(before.length===after.length);return before.flatMap((a,i)=>{const b=after[i];need(a.rootId===i&&b.rootId===i);return a.kind===b.kind&&a.reason===b.reason?[]:[{rootId:i,before:{kind:a.kind,reason:a.reason},after:{kind:b.kind,reason:b.reason}}];});
}
export function validateDelta(v:unknown,from:Engine,to:Engine,before:Verdict[],after:Verdict[]):void {
 const endpoint:Check=x=>{shape(x,{kind,reason:str});};
 const o=shape(v,{version,from:engine,to:engine,rows:list(x=>{shape(x,{rootId:uint,before:endpoint,after:endpoint});})});
 need(o.from===from&&o.to===to);same(o.rows,deltaRows(before,after));
}
/** Both exact raw output and actual separately-obtained normal planner groups are required.
 * This pure check does not prove the groups came from a native planner; that custody is external. */
export function validateNativeStdout(rawBytes:Uint8Array,roots:string[],values:Verdict[],actualNormalGroups:unknown):void {
 validateSuite({version:1,paths:roots});validateVerdicts(values,roots);
 for(const v of values)need(!/[\u0000-\u001f\u007f]/.test(v.reason)&&v.reason.trim()===v.reason);
 const expected=values.map(v=>`${v.kind}\t${roots[v.rootId]}\t${v.reason}\n`).join('');const encoded=new TextEncoder().encode(expected);need(rawBytes.length===encoded.length&&rawBytes.every((v,i)=>v===encoded[i]));let raw:string;try{raw=utf8.decode(rawBytes);}catch{fail();}
 const groups=shape(actualNormalGroups,{db:list(rootPath),nodb:list(rootPath)});
 const decoded={db:[] as string[],nodb:[] as string[]};
 // Exact normal plan.mjs trim/split/destructure course, with stricter ambiguity rejection above.
 for(const [tag,file] of raw.trim().split('\n').map(line=>line.split('\t'))){need(['DB','NODB'].includes(tag)&&roots.includes(file));decoded[tag==='DB'?'db':'nodb'].push(file);}
 same([...decoded.db,...decoded.nodb].sort(),roots);same(groups,decoded);
}

const phaseCheck:Check=v=>{shape(v,{version,stage:nonempty,complete:bool,startNs:decimal,endNs:decimal,workLimitMs:positive,settlementLimitMs:fixed(6000),outcome:fixed('complete','refused','deadline','owner-loss','unsettled')});};
const contextCheck:Check=v=>{shape(v,{version,source:git,inventorySha256:sha,negativeSourceIds:list(uint),positiveSourceIds:list(uint)});};
const metadata:Record<string,Check>={
 'binding.json':v=>{shape(v,{version,kind:fixed('UNAUTHENTICATED_FORMAT_ONLY'),purpose,source:git,controller:git,run:decimal,attempt:positive,job:decimal,node:fixed('22.23.3'),programs:list(x=>{shape(x,{engine,sha256:sha,gitSource:git});})});},
 'anchor.json':v=>{shape(v,{version,bootId:v=>need(typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)),wallMs:decimal,monotonicNs:decimal,run:decimal,attempt:positive,job:decimal,purpose});},
 'prerequisites.json':v=>{shape(v,{version,sourceClean:bool,controllerClean:bool,inventorySha256:sha,suiteSha256:sha,stdinSha256:sha});},
 'report.json':reportCheck,
 'semantic-parent.json':v=>{shape(v,{version,source:git,controller:git,run:decimal,attempt:positive,job:decimal,artifact:decimal,archiveSha256:sha,archiveBytes:uint});},
 'package-context.json':v=>{shape(v,{version,node:fixed('22.23.3'),loader:fixed('native'),basename:fixed('gate-db-classify.ts'),packageSha256:sha,programSha256:sha,imports:list(fixed('node:fs'))});},
 'native-clock.json':v=>{shape(v,{version,startNs:decimal,endNs:decimal,workLimitMs:fixed(15000),settlementLimitMs:fixed(6000),deadlineHit:bool});},
 'stdin-stream.json':v=>{shape(v,{version,kind:fixed('NODE_STDIO_STREAM_SOCKET_NOT_FIFO'),inputSha256:sha,inputBytes:uint,writeFinished:bool,writerClosed:bool,readerClosed:bool,eofObserved:bool,transportError:bool});},
 'native-result.json':v=>{shape(v,{version,exitCode:nullable(uint),signal:nullable(fixed('SIGTERM','SIGKILL','SIGABRT','SIGSEGV','SIGINT')),deadlineHit:bool,familySettled:bool,normalPlanConformance:bool});},
 'source-pre.json':contextCheck,'source-post.json':contextCheck,
 'phase-collect.json':phaseCheck,'phase-replay.json':phaseCheck,'phase-parent-auth.json':phaseCheck,'phase-seal.json':phaseCheck,
};
/** Closed JSON schemas for native records are proposals, NOT validation of the represented facts. */
export function validateMetadataMember(name:string,value:unknown):void { need(Object.hasOwn(metadata,name));metadata[name](value); }
export function validateOwnershipJsonl(raw:string,p:Purpose):void {
 need(raw.endsWith('\n'));const lines=raw.slice(0,-1).split('\n');need(lines.length>0);let seq=0;
 for(const line of lines){const o=shape(decodeCanonicalJson(line+'\n'),{version,sequence:uint,stage:nonempty,event:fixed('admitted','started','settled','refused'),pid:positive,startTicks:decimal,parentPid:positive,parentStartTicks:decimal,groupId:positive,sessionId:positive,stdinKind:fixed('socket','not-applicable'),stdinDevice:nullable(decimal),stdinInode:nullable(decimal),settled:bool});need(o.sequence===seq++&&stageNames(p).includes(o.stage as string));need(o.stdinKind==='socket'?(o.stdinDevice!==null&&o.stdinInode!==null):(o.stdinDevice===null&&o.stdinInode===null));}
}

const utf8 = new TextDecoder('utf-8',{fatal:true});
export type ArchiveMember = {name:string;bytes:Uint8Array};
/** UTF-8 framing/size/member checks only. No ZIP extraction, source fetch or native trust. */
export function decodeMembers(p:Purpose,input:ArchiveMember[]):Map<string,string|Uint8Array> {
 need(input.length<=100);unique(input.map(x=>x.name));let total=0;const out=new Map<string,string|Uint8Array>();
 const allowed=p==='semantic'?SEMANTIC_MEMBERS:CLI_MEMBERS;
 for(const {name,bytes} of input){need(allowed.includes(name)&&bytes instanceof Uint8Array&&bytes.length<=memberLimit(name));total+=bytes.length;need(total<=128*1024*1024);
  if(name.endsWith('tracked.bin')||name==='native.stdout'||name==='native.stderr')out.set(name,bytes.slice());else{let s:string;try{s=utf8.decode(bytes);}catch{fail();}out.set(name,s!);}
 }
 const r=out.get('report.json');need(typeof r==='string');const report=decodeCanonicalJson(r as string);validateMemberSet(p,[...out.keys()],report);
 return out;
}
/** Parse actual Git --stage -z output, preserving tabs/newlines in paths after FIRST tab. */
export function parseTracked(raw:Uint8Array):{mode:string;blob:string;path:string}[]{
 need(raw.length>0&&raw[raw.length-1]===0);let s:string;try{s=utf8.decode(raw);}catch{fail();}
 const records=s!.slice(0,-1).split('\0').map(record=>{const tab=record.indexOf('\t');need(tab>0);const header=record.slice(0,tab),file=record.slice(tab+1);const m=/^(100644|100755) ([0-9a-f]{40}) 0$/.exec(header);need(m);path(file);return{mode:m![1],blob:m![2],path:file};});
 unique(records.map(r=>r.path));const enc=new TextEncoder();const compare=(a:string,b:string)=>{const x=enc.encode(a),y=enc.encode(b);for(let i=0;i<Math.min(x.length,y.length);i++)if(x[i]!==y[i])return x[i]-y[i];return x.length-y.length;};same(records.map(r=>r.path),records.map(r=>r.path).sort(compare));return records;
}
/** Validate EACH present complete member; cross-member content equality is mandatory even for partial output. */
export function validateArchiveData(p:Purpose,input:ArchiveMember[]):void {
 const data=decodeMembers(p,input),json=(name:string):unknown=>decodeCanonicalJson(data.get(name) as string);
 const report=json('report.json') as Obj;need(report.purpose===p);
 for(const [name,raw] of data){
  if(Object.hasOwn(metadata,name)){validateMetadataMember(name,json(name));continue;}
  if(name==='native-ownership.jsonl'){validateOwnershipJsonl(raw as string,p);continue;}
  if(name.endsWith('tracked.bin')){parseTracked(raw as Uint8Array);continue;}
  if(name.includes('head.stdout')){need(/^[0-9a-f]{40}\n$/.test(raw as string));continue;}
  if(name.includes('status.stdout')){need(raw==='');continue;}
  if(name.endsWith('.ts')){need((raw as string).length>0);continue;}
  // Typed relation members below require their dependencies; partial prefixes may not skip them.
  if(name==='native.stdout'||name==='native.stderr'||name==='stdin.txt')continue;
  need(name==='suite.json'||name==='snapshot-index.json'||name.startsWith('calls-')||name==='graph.json'||name==='reasons.json'||name.startsWith('semantic-')||name.startsWith('delta-'));
 }
 const suite=data.has('suite.json')?validateSuite(json('suite.json')):null;
 if(data.has('stdin.txt')){need(suite);sameRaw(data.get('stdin.txt') as string,suite!.join('\n')+'\n');}
 const snap=data.has('snapshot-index.json')?validateSnapshot(json('snapshot-index.json')):null;
 for(const e of ['a','b','c'] as Engine[])if(data.has(`calls-${e}.json`)){need(snap);validateCalls(json(`calls-${e}.json`),snap!,e);}
 if(snap&&['a','b','c'].every(e=>data.has(`calls-${e}.json`))){const seen=new Set<number>();for(const e of ['c','b','a'] as Engine[])for(const call of (json(`calls-${e}.json`) as Obj).rows as Obj[]){const id=call.sourceId as number;if(!seen.has(id)){need(snap.rows[id].firstSeen===seen.size&&snap.rows[id].firstEngine===e);seen.add(id);}}need(seen.size===snap.rows.length);}
 if(data.has('graph.json')){need(snap&&suite);validateGraph(json('graph.json'),snap!,suite!);}
 let verdicts:Record<Engine,Verdict[]>|null=null;
 if(data.has('reasons.json')){need(suite&&data.has('graph.json'));const graph=json('graph.json') as Obj;verdicts=validateReasons(json('reasons.json'),suite!,(graph.nodes as unknown[]).length);validateReasonEdges(json('reasons.json'),graph,verdicts.b,snap!,suite!);}
 for(const e of ['a','b','c'] as Engine[])if(data.has(`semantic-${e}.tsv`)){need(suite&&verdicts);same(parseSemanticTsv(data.get(`semantic-${e}.tsv`) as string,suite!),verdicts![e]);}
 for(const [a,b] of [['a','b'],['a','c'],['b','c']] as [Engine,Engine][])if(data.has(`delta-${a}-${b}.json`)){need(verdicts);validateDelta(json(`delta-${a}-${b}.json`),a,b,verdicts![a],verdicts![b]);}
 for(const name of ['phase-collect.json','phase-replay.json','phase-parent-auth.json','phase-seal.json'])if(data.has(name)){const v=json(name) as Obj;need(v.stage===name.slice(6,-5));need(v.workLimitMs===(name==='phase-parent-auth.json'?120000:name==='phase-seal.json'?10000:15000));need(BigInt(v.endNs as string)>=BigInt(v.startNs as string));if(report.complete)need(v.complete===true&&v.outcome==='complete');}
 const binding=json('binding.json') as Obj;need(binding.purpose===p);const programs=binding.programs as Obj[];same(programs.map(x=>x.engine),p==='semantic'?['a','b','c']:[p==='cli-b'?'b':'c']);
 const anchor=json('anchor.json') as Obj;for(const key of ['purpose','run','attempt','job'])need(anchor[key]===binding[key]);
 if(snap)for(const name of ['source-pre.json','source-post.json'])if(data.has(name)){const v=json(name) as Obj;need(v.source===binding.source);same(v.negativeSourceIds,snap.rows.filter(r=>r.value===null).map(r=>r.id));same(v.positiveSourceIds,snap.rows.filter(r=>r.value!==null).map(r=>r.id));}
 // Raw native stdout requires semantic-parent verdicts AND the separately obtained actual normal
 // planner interpretation at the independent final receiver: use validateNativeStdout there.
 // The format owner deliberately cannot confer that external conjunction from producer JSON.
}
function validateReasonEdges(value:unknown,graph:Obj,vs:Verdict[],snap:Snapshot,roots:string[]):void {
 const nodes=graph.nodes as Obj[],ws=(value as Obj).witnesses as Obj[];
 for(const w of ws){const seq=w.nodeIds as number[];if(seq.length===0)continue;
  need(snap.rows[nodes[seq[0]].sourceId as number].path===roots[w.rootId as number]);
  for(let i=1;i<seq.length;i++)need((nodes[seq[i-1]].steps as Obj[]).some(s=>s.kind==='helper'&&s.targetId===seq[i]));
  const steps=nodes[w.directNodeId as number].steps as Obj[],index=w.directStepIndex as number;need(index<steps.length);const terminal=steps[index];need(terminal.kind==='direct'&&terminal.reason===vs[w.rootId as number].reason);
 }
}
