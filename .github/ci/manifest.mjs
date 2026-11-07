/** Coverage topology is deterministic; scheduler concurrency never changes batch membership. */
import {createHash} from 'node:crypto';
import {balanceDatabaseFiles,DB_SCHEDULING} from './db-scheduling.mjs';
import {PDF_TOOL_CONSUMERS} from './pdf-tool-scope.mjs';
import {V15_POSTGRES_PROFILE} from './postgres-evidence.mjs';
import {singletonDescriptor,singletonKind,nativeNextUnit,singletonJobName} from './singleton-protocol.mjs';
export const CI_EXECUTION={workers:2,postgres:V15_POSTGRES_PROFILE,scheduling:DB_SCHEDULING};
export const DB_BATCH_FILES=24;
export const NODB_BATCH_FILES=256;
export const BROWSER_ENGINES=['chromium','firefox','webkit'];
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function inventory(files,pattern){
 if(!Array.isArray(files)||files.length===0||files.some(f=>typeof f!=='string'||!pattern.test(f)||f.split('/').some(p=>!p||p==='.'||p==='..'))||new Set(files).size!==files.length)throw Error('Invalid complete test inventory');
 return files.slice().sort();
}
export function buildUnits(suite,groups,browserFiles){
 const complete=inventory(suite,/^test\/[A-Za-z0-9_./-]+(?:\.test\.ts|\.dom\.test\.tsx)$/);
 if(!groups||!Array.isArray(groups.db)||!Array.isArray(groups.nodb)||JSON.stringify([...groups.db,...groups.nodb].sort())!==JSON.stringify(complete))throw Error('Classifier does not partition complete suite exactly');
 const browser=inventory(browserFiles,/^test\/[A-Za-z0-9_./-]+\.browser\.test\.tsx$/);
 const units=[];
 for(const kind of ['nodb','db']){
  const all=groups[kind].slice().sort(),special=all.filter(f=>singletonDescriptor(f)),files=all.filter(f=>!singletonDescriptor(f)),size=kind==='db'?DB_BATCH_FILES:NODB_BATCH_FILES;
  for(const file of special){const descriptor=singletonDescriptor(file);if(singletonKind(descriptor.profile)!==kind)throw Error('Singleton capability disagrees with native DB classification');units.push({id:`${kind}-${hash({file,descriptor}).slice(0,16)}`,kind,files:[file],pdfTools:false,singleton:descriptor});}
  if(kind==='db'&&files.some(f=>PDF_TOOL_CONSUMERS.includes(f)))throw Error('Audited PDF tool consumers must retain their no-DB classification');
  const ordinary=kind==='nodb'?files.filter(f=>!PDF_TOOL_CONSUMERS.includes(f)):files,pdf=kind==='nodb'?files.filter(f=>PDF_TOOL_CONSUMERS.includes(f)):[];
  const batches=kind==='db'?balanceDatabaseFiles(files,size):Array.from({length:Math.ceil(ordinary.length/size)},(_,i)=>ordinary.slice(i*size,(i+1)*size));
  if(pdf.length)batches.push(pdf);
  for(const batch of batches)units.push({id:`${kind}-${hash(batch).slice(0,16)}`,kind,files:batch,pdfTools:batch.some(f=>PDF_TOOL_CONSUMERS.includes(f))});
 }
 for(const engine of BROWSER_ENGINES)units.push({id:`browser-${engine}`,kind:'browser',engine,files:browser.slice(),pdfTools:false});
 if(new Set(units.map(u=>u.id)).size!==units.length||units.length>256)throw Error('Invalid or excessive batch identity inventory');
 return units;
}
/** Call with the locally reconstructed plan, never a downloaded artifact as authority. */
export function requiredEvidence(expectedPlan){
 if(!expectedPlan||!Array.isArray(expectedPlan.units))throw Error('Missing independently reconstructed manifest');
 const groups={db:[],nodb:[]};
 for(const u of expectedPlan.units){if(u.kind==='db'||u.kind==='nodb')groups[u.kind].push(...u.files);else if(u.kind!=='browser')throw Error('Unknown manifest unit kind');}
 const browser=expectedPlan.units.find(u=>u.kind==='browser')?.files;
 if(JSON.stringify(buildUnits(expectedPlan.suite,groups,browser))!==JSON.stringify(expectedPlan.units))throw Error('Incomplete or altered manifest topology');
 const units=expectedPlan.units.map(u=>u.id);
 return {units,jobs:['resolve','plan','controller-tests','migrations','typecheck','build',...expectedPlan.units.map(singletonJobName),'verify','deployment-hold'],artifacts:['gate-plan','gate-evidence','production-build-v1',...units.map(id=>`unit-${id}`)]};
}

/** A skipped empty matrix is optional only when its capability has no units. */
export const optionalSkippedCiJob=(name,plan)=>['runner-diagnostics','commission-summary'].includes(name)||name==='native-test'&&!plan.units.some(nativeNextUnit);
