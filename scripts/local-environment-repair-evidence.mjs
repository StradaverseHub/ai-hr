/** Read actual local artifacts and independently rebuild their coverage. No DB, SSH or writes. */
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isDeepStrictEqual as equal} from 'node:util';
import {LOCAL_REPAIR as P,digest,requireRepair,validateOriginalPortAttempt,validateLocalEnvironmentRepair} from './local-environment-repair.mjs';

export const controllerDirectory=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:128*1024*1024}).trim();
export function cleanRepairHead(cwd){
 requireRepair(realpathSync(cwd)===resolve(cwd),'noncanonical worktree');
 const sha=git(cwd,'rev-parse','HEAD');
 requireRepair(/^[a-f0-9]{40}$/.test(sha)&&!git(cwd,'status','--porcelain'),'dirty or missing worktree');
 requireRepair(git(cwd,'remote','get-url','origin').toLowerCase()==='https://github.com/stradaversehub/ai-hr.git','unexpected repository origin');
 return sha;
}
export async function loadFrozenModule(candidatePath,path){
 const raw=await import(pathToFileURL(join(candidatePath,path)).href);
 return {...(raw.default??{}),...raw};
}
export function repairArtifactReader(root,group,manifest){
 root=resolve(root);
 requireRepair(realpathSync(root)===root&&lstatSync(root).isDirectory(),'archive must be a canonical directory');
 let size=0;
 return path=>{
  requireRepair(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'),'unsafe artifact path');
  const file=join(root,path),stat=lstatSync(file);
  requireRepair(stat.isFile()&&!stat.isSymbolicLink()&&realpathSync(file)===file,'artifact must be a regular nonsymlink file');
  requireRepair(stat.size<=16*1024*1024&&(size+=stat.size)<=128*1024*1024,'artifact size bound exceeded');
  const bytes=readFileSync(file);
  requireRepair(bytes.length===stat.size,'artifact changed while reading');
  manifest.push({group,path,bytes:bytes.length,sha256:digest(bytes)});
  return bytes.toString('utf8');
 };
}
const list=text=>{requireRepair(text.endsWith('\n'),'incomplete inventory file');return text.slice(0,-1).split('\n');};
function inventory(read,expected){
 const value={all:list(read('all-files.txt')),db:list(read('db-files.txt')),nodb:list(read('nodb-files.txt'))};
 requireRepair(equal(value,{all:expected.all,db:expected.db,nodb:expected.nodb}),'inventory differs from independent source classification');
 const classification=list(read('classify.tsv')).map(line=>line.split('\t').slice(0,2).join('\t')).sort();
 requireRepair(equal(classification,[...value.db.map(p=>'DB\t'+p),...value.nodb.map(p=>'NODB\t'+p)].sort()),'classification metadata differs');
 return value;
}
async function expectedSource(candidatePath,baseline){
 const sha=cleanRepairHead(candidatePath),tree=git(candidatePath,'rev-parse','HEAD^{tree}');
 requireRepair(sha===P.candidate&&tree===P.tree&&baseline===P.baseline,'outside bounded candidate/baseline');
 execFileSync('git',['merge-base','--is-ancestor',baseline,sha],{cwd:candidatePath,stdio:'ignore'});
 const source=await loadFrozenModule(candidatePath,'scripts/gate-impact-git.ts');
 const classifier=await loadFrozenModule(candidatePath,'scripts/gate-db-classify.ts');
 const files=source.sourceFiles(candidatePath);
 const all=[...files.keys()].filter(p=>/^test\/.+\.(?:test\.ts|dom\.test\.tsx)$/.test(p)).sort();
 const {db,nodb}=classifier.classifyTestFiles(all,p=>files.get(p)??null);
 const expected={sha,tree,baseline,environmentHash:source.environmentHash(candidatePath),all,db,nodb};
 // The pure summary parser used by this controller must be the exact candidate's parser.
 requireRepair(digest(readFileSync(join(candidatePath,'scripts/gate-phase-reuse.ts')))===digest(readFileSync(join(controllerDirectory,'scripts/gate-phase-reuse.ts'))),'summary-parser source differs');
 return expected;
}
function originalEvidence(read,expected){
 const full=path=>read('full/'+path),learning=JSON.parse(full('learning.json'));
 const runnerHash=digest(read('run.py'));
 const input={runnerHash,inventory:inventory(full,expected),plan:JSON.parse(full('plan.json')),learning,receipt:learning.fullReceipt,result:JSON.parse(read('result.json')),
  controller:full('full-controller.log'),noDbLog:full('nodb.log'),chunkLogs:Array.from({length:16},(_,i)=>full(`chunk${i+1}.log`)),
  focusedLog:read('focused-repairs.log'),buildLog:read('production-build.log'),browserLogs:Object.fromEntries(['chromium','firefox','webkit'].map(e=>[e,read('browser-'+e+'.log')]))};
 requireRepair(input.plan.plan?.fingerprint===P.originalImpactFingerprint,'original impact plan fingerprint differs from reviewed run');
 read('whole-typecheck.log');
 const start=JSON.parse(read('started.json')),cluster=JSON.parse(read('owned-cluster.json'));
 requireRepair(start.startedAt===1792930539.054941&&start.sha===P.candidate&&start.privatePort===5439&&start.startedAt===input.result.startedAt&&start.privatePgdata===input.result.privatePgdata&&equal(start.leases,input.result.leases),'original started/terminal ownership differs');
 requireRepair(cluster.port===5439&&cluster.dataDirectory===start.privatePgdata&&cluster.systemIdentifier==='7700578147171919909','original owned cluster differs');
 return input;
}
export async function collectOriginalPortAttempt({candidatePath,originalDirectory,baseline=P.baseline}){
 candidatePath=resolve(candidatePath);
 const expected=await expectedSource(candidatePath,baseline),artifacts=[];
 const read=repairArtifactReader(originalDirectory,'original',artifacts);
 const original=originalEvidence(read,expected);
 const proof=validateOriginalPortAttempt(original,expected);
 requireRepair(cleanRepairHead(candidatePath)===expected.sha,'candidate changed while inspecting original');
 return {original,expected,proof,artifacts};
}
export async function collectLocalEnvironmentRepair({candidatePath,originalDirectory,freshDirectory,baseline=P.baseline,now=Date.now()}){
 candidatePath=resolve(candidatePath);freshDirectory=resolve(freshDirectory);
 const controller=cleanRepairHead(controllerDirectory);
 const {original,expected,artifacts}=await collectOriginalPortAttempt({candidatePath,originalDirectory,baseline});
 const read=repairArtifactReader(freshDirectory,'fresh',artifacts),json=path=>JSON.parse(read(path));
 const admissionDirectory=freshDirectory+'-lock-environment-attempt';
 const history=repairArtifactReader(admissionDirectory,'admission',artifacts),historyJson=path=>JSON.parse(history(path));
 const admission={runnerHash:digest(history('run.py')),result:historyJson('result.json'),controller:history('repair-batch-11.log'),receiptBefore:history('full-receipt-before.json'),sharedBefore:historyJson('shared-before-smart-stop.json'),sharedAfter:historyJson('shared-restored.json')};
 const priorBorrowHash=digest(history('borrow-canonical.py'));
 const priorProvenance=historyJson('execution-provenance.json');
 requireRepair(priorBorrowHash===P.freshScripts['borrow-canonical.py']&&priorProvenance.scripts?.['borrow-canonical.py']===priorBorrowHash&&priorProvenance.sha===P.candidate&&priorProvenance.baseline===baseline&&priorProvenance.scripts?.['run.py']===P.interruptedRunner&&priorProvenance.chunkFrom===11&&priorProvenance.chunkTo===11&&priorProvenance.workers===2&&!existsSync(join(admissionDirectory,'repair-slice')),'prior admission provenance differs or tests started');
 history('shared-smart-stopped.json');history('restore-shared.log');
 const scriptHashes=Object.fromEntries(Object.keys(P.freshScripts).map(f=>[f,digest(read(f))]));
 requireRepair(equal(scriptHashes,P.freshScripts),'reviewed fresh scripts changed');
 const provenance=json('execution-provenance.json'),endpoint=json('canonical-environment.json'),settings=endpoint.settings;
 requireRepair(provenance.sha===expected.sha&&provenance.baseline===baseline&&equal(provenance.command,['bash','scripts/gate-chunked.sh'])&&provenance.workerHeapMiB===4096&&equal(provenance.scripts,scriptHashes)&&provenance.node===endpoint.node&&provenance.node===process.version,'fresh invocation provenance differs');
 const receiptBefore=read('full-receipt-before.json'),receiptAfter=read('full-receipt-after.json');
 requireRepair(digest(receiptBefore)===provenance.originalFullReceiptSha256,'original full receipt hash changed');
 const result=json('result.json'),started=json('started.json'),cluster=json('owned-cluster.json');
 requireRepair(started.sha===expected.sha&&started.startedAt===result.startedAt&&started.originalWindowStartedAt===result.originalWindowStartedAt&&started.privatePort===5433&&started.privatePgdata===result.privatePgdata&&equal(started.leases,result.leases),'fresh started/terminal ownership differs');
 requireRepair(cluster.port===5433&&cluster.dataDirectory===settings.data_directory&&cluster.systemIdentifier===settings.system_identifier,'fresh actual cluster identities differ');
 const approval=json('human-port-handover-approval.json');
 requireRepair(approval.explicitHumanApproval===true&&approval.directHumanAnswer==='Allow temporary stop and restore'&&approval.sourceQuestionCall==='call_afff6451027b45989f2c070674f6b35c'&&approval.systemIdentifier===P.sharedSystem&&approval.smartStopOnly===true&&approval.restoreAfterBoard3===true&&approval.resetPermitted===false&&approval.deletePermitted===false,'port handover approval differs');
 const slice=path=>read('repair-slice/'+path);
 const fresh={directory:freshDirectory,scriptHashes,sha:provenance.sha,baseline:provenance.baseline,environmentHash:endpoint.environmentHash,inventory:inventory(slice,expected),range:{chunks:provenance.chunks,from:provenance.chunkFrom,to:provenance.chunkTo,workers:provenance.workers},result,
  endpoint:{candidate:provenance.sha,environmentHash:endpoint.environmentHash,jit:settings.jit,version:settings.version,dataDirectory:settings.data_directory,systemIdentifier:settings.system_identifier,connections:endpoint.connections},
  receiptBefore,receiptAfter,controller:read('repair-batch-11.log'),chunkLogs:[slice('chunk11.log')],sharedBefore:json('shared-before-smart-stop.json'),sharedStopped:json('shared-smart-stopped.json'),sharedAfter:json('shared-restored.json')};
 // Bind rebuild and migration records even though the natural controller exit also requires success.
 slice('rebuild11.log');slice('migrate11.log');read('capture-canonical-environment.log');read('restore-shared.log');
 requireRepair(Date.parse(endpoint.observedAt)/1000>=result.steps[2].startedAt&&Date.parse(endpoint.observedAt)/1000<=result.steps[2].endedAt,'actual cluster proof timestamp differs');
 requireRepair(result.endedAt*1000<=now&&now-original.result.startedAt*1000<24*3600*1000,'evidence is future-dated or older than this bounded release');
 const currentReceipt=readFileSync(join(candidatePath,'.gate-receipt.json'),'utf8');
 requireRepair(currentReceipt===receiptAfter,'candidate failed full receipt changed after repair');
 const input={original,fresh,admission,authorization:{scope:P.authorization,threadId:'01a16508-ab6a-7e72-8b47-5dd1c6012ace'}};
 const proof=validateLocalEnvironmentRepair(input,expected);
 requireRepair(cleanRepairHead(candidatePath)===expected.sha&&cleanRepairHead(controllerDirectory)===controller,'source changed during evidence verification');
 return {...proof,controller,candidatePath,originalDirectory:resolve(originalDirectory),freshDirectory,admissionDirectory,environmentHash:expected.environmentHash,artifacts:artifacts.sort((a,b)=>(a.group+'/'+a.path).localeCompare(b.group+'/'+b.path)),failedFullReceiptSha256:digest(receiptAfter)};
}
