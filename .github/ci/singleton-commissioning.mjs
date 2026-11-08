/** Selected native profile commissioning is development evidence, never a full gate. */
import {readFileSync,writeFileSync,readdirSync,lstatSync,appendFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createPlan,hash} from './plan.mjs';
import {assertSingletonUnit,nativeNextUnit} from './singleton-protocol.mjs';
import {verifyUnitReport} from './verify-shards.mjs';
import {employeeLifecycleMatrixRow} from './employee-lifecycle-profile.mjs';
export const COMMISSION_TITLE='Singleton commissioning only';
export function commissioningIntent(eventName,inputs={},attempt){
 const raw=inputs.commission_singleton_units===undefined?'':inputs.commission_singleton_units;
 if(typeof raw!=='string'||raw.length>1024)throw Error('Invalid singleton commissioning input');
 if(raw==='')return null;
 if(eventName!=='workflow_dispatch'||String(attempt)!=='1'||['build_only','diagnostics_only','controller_only'].some(k=>inputs[k]===true||inputs[k]==='true'))throw Error('Commissioning requires exclusive first-attempt manual intent');
 let ids;try{ids=JSON.parse(raw);}catch{throw Error('Commissioning requires a JSON array of registered unit IDs');}
 if(!Array.isArray(ids)||ids.length<1||ids.length>16||ids.some(id=>typeof id!=='string'||!/^(?:db|nodb)-[0-9a-f]{16}$/.test(id))||new Set(ids).size!==ids.length)throw Error('Invalid or duplicated singleton commissioning selection');
 return ids;
}
export function selectCommissioning(plan,ids){
 if(!Array.isArray(ids)||ids.length<1||ids.length>16||ids.some(id=>typeof id!=='string'||!/^(?:db|nodb)-[0-9a-f]{16}$/.test(id))||new Set(ids).size!==ids.length)throw Error('Invalid commissioning selection');
 for(const id of ids){const matches=plan.units.filter(u=>u.id===id);if(matches.length!==1||!matches[0].singleton)throw Error('Commissioning requires exact registered complete singleton units');assertSingletonUnit(matches[0]);}
 return {schemaVersion:1,kind:'SELECTED_PROFILE_COMMISSIONING_ONLY',candidate:plan.sha,controller:plan.controller,baseline:plan.migrationBase,fingerprint:plan.fingerprint,selected:[...ids].sort(),omitted:plan.units.filter(u=>!ids.includes(u.id)).map(u=>u.id).sort(),completeSuite:false,releaseAuthorized:false};
}
export function summarizeCommissioning(plan,selection,entries,witness){
 if(!/^[1-9][0-9]*$/.test(String(witness?.runId))||String(witness?.attempt)!=='1')throw Error('Invalid commissioning witness');
 if(!isDeepStrictEqual(selection,selectCommissioning(plan,selection?.selected)))throw Error('Commissioning selection differs from the complete source plan');
 if(typeof entries?.[Symbol.iterator]!=='function')throw Error('Invalid commissioning reports');
 const seen=new Set(),outcomes=[];
 for(const {bytes,report} of entries){
  if(outcomes.length>=16)throw Error('Excessive commissioning reports');
  if(typeof bytes!=='string'||!isDeepStrictEqual(JSON.parse(bytes),report))throw Error('Commissioning raw report bytes differ from parsed evidence');
  if(!selection.selected.includes(report?.id)||seen.has(report.id))throw Error('Unknown or duplicated commissioning report');
  seen.add(report.id);
  let verified,error;
  try{verified=verifyUnitReport(plan,report,witness);}catch(e){error=String(e.message).slice(0,500);}
  outcomes.push({id:report.id,reportHash:hash(bytes),outcome:verified?'verified':'refused',...(verified?{tests:verified.tests}:{error})});
 }
 for(const id of selection.selected)if(!seen.has(id))outcomes.push({id,outcome:'missing'});
 return {...selection,runId:String(witness.runId),attempt:String(witness.attempt),outcomes:outcomes.sort((a,b)=>a.id.localeCompare(b.id)),selectedProfilesVerified:outcomes.every(o=>o.outcome==='verified')};
}
function readBounded(file,max){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('Invalid bounded commissioning file');return readFileSync(file,'utf8');}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,...args]=process.argv.slice(2);
 const event=JSON.parse(readBounded(process.env.GITHUB_EVENT_PATH,64*1024*1024));
 const ids=commissioningIntent(process.env.GITHUB_EVENT_NAME,event.inputs,process.env.GITHUB_RUN_ATTEMPT);
 if(mode==='intent'){console.log(ids?'Selected native profiles only; release remains refused.':'Ordinary workflow intent.');}
 else if(mode==='matrix'){
  const plan=JSON.parse(readBounded(args[0],16*1024*1024));
  const selection=ids?selectCommissioning(plan,ids):null;
  const unit=selection?.selected??plan.units.filter(u=>u.kind!=='browser').map(u=>u.id);
  if(!unit.length||unit.length>256||new Set(unit).size!==unit.length)throw Error('Invalid test matrix');
  if(selection)writeFileSync(args[1],JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
  const ordinary=unit.filter(id=>!nativeNextUnit(plan.units.find(u=>u.id===id))),native=unit.filter(id=>nativeNextUnit(plan.units.find(u=>u.id===id)));
  appendFileSync(process.env.GITHUB_OUTPUT,'test_matrix='+JSON.stringify({include:ordinary.map(id=>employeeLifecycleMatrixRow(plan.units.find(u=>u.id===id)))})+'\n'+'native_matrix='+JSON.stringify({unit:native})+'\n'+'has_tests='+String(ordinary.length>0)+'\n'+'has_native='+String(native.length>0)+'\n');
 }else if(mode==='summary'){
  if(!ids)throw Error('Commissioning summary requires explicit intent');
  const plan=createPlan(),selection=JSON.parse(readBounded(args[0],1024*1024));
  if(!isDeepStrictEqual(selection,selectCommissioning(plan,ids)))throw Error('Frozen commissioning intent drift');
  const files=readdirSync(args[1]).filter(f=>/^unit-.+\.json$/.test(f));
  if(files.length>16)throw Error('Excessive commissioning reports');
  // Verify one bounded report at a time; do not retain sixteen large native plans.
  function* entries(){for(const f of files){const bytes=readBounded(join(args[1],f),64*1024*1024);yield {bytes,report:JSON.parse(bytes)};}}
  const summary=summarizeCommissioning(plan,selection,entries(),{runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT});
  writeFileSync(args[2],JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Selected native profiles: ${summary.outcomes.filter(o=>o.outcome==='verified').length}/${summary.selected.length} verified; ${summary.omitted.length} units omitted. Incomplete development evidence; release authorization is false.\n`);
  if(!summary.selectedProfilesVerified)process.exitCode=1;
 }else throw Error('Unknown commissioning command');
}
