/** Metadata interpretation only. Unknown native context never grants coverage. */
import assert from 'node:assert/strict';
import {resolve,isAbsolute,relative} from 'node:path';
import {stronglyConnected,REFERENCE_LIMITS} from './graph.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const APPLICATION_PHASES=Object.freeze(['next-typegen','original-cli','original-api','build-cli']);
export function parseNativeExplanation(text,source){
 assert(typeof text==='string'&&Buffer.byteLength(text)<=REFERENCE_LIMITS.logBytes&&isAbsolute(source));
 const files=[];let current;
 for(const line of text.replaceAll('\r\n','\n').split('\n')){
  if(line==='')continue;
  if(line.startsWith('  ')){assert(current,'Native reason without file');current.reasons.push(line.slice(2));}
  else{assert(!/^\s/.test(line)&&!line.includes('\0'),'Unknown native explanation framing');current={logicalPath:resolve(source,line),displayPath:line,reasons:[]};files.push(current);assert(files.length<=50000);}
 }
 assert(files.length>0&&new Set(files.map(row=>row.logicalPath)).size===files.length,'Complete unique native explanation membership required');
 assert(files.every(row=>row.reasons.length>0),'Native file without explanation');return files;
}
export function reconcileNativeMembership(cli,api){
 assert(Array.isArray(api.files)&&Array.isArray(api.roots)&&Array.isArray(api.observations)&&Array.isArray(api.gaps));
 assert(same(cli.map(row=>row.logicalPath),api.files.map(row=>row.logicalPath)),'Native CLI / default Program ordered membership mismatch');
 const loaded=new Set(api.files.map(row=>row.logicalPath));assert(api.roots.every(root=>loaded.has(root)),'Configured native root absent');
 const gaps=[...api.gaps],reasonObservations=[];
 for(const file of cli)for(const reason of file.reasons){
  // Native CLI owns these strings. Retain every form and declare the missing
  // semantic reconciliation; recognisable text is never an invented graph edge.
  const kind=/^Imported via /.test(reason)?'import':/^Referenced via /.test(reason)?'path':/^Type library referenced via /.test(reason)?'type':/^Library referenced via /.test(reason)?'lib':/^Entry point of type library /.test(reason)?'automatic-type':/^Library specified in compilerOptions|^Default library /.test(reason)?'default-library':/^Matched by include pattern|^Part of .files. list|^Root file specified/.test(reason)?'root':/^File is /.test(reason)?'package-mode':'unknown';
  reasonObservations.push({file:file.logicalPath,kind,reason});
  if(kind==='package-mode')gaps.push({kind:'native-package-mode-reconciliation-open',file:file.logicalPath,reason});
  if(kind==='unknown')gaps.push({kind:'unknown-native-explanation-form',file:file.logicalPath,reason});
  if(['import','path','type','lib','automatic-type'].includes(kind))gaps.push({kind:'native-reason-edge-reconciliation-open',file:file.logicalPath,reason});
 }
 for(const observation of api.observations)if(observation.target?.packageId)gaps.push({kind:'native-package-id-and-resolution-mode-reconciliation-open',from:observation.from,specifier:observation.specifier,mode:observation.mode??null,packageId:observation.target.packageId,target:observation.target.logicalPath});
 const byPhysical=new Map();for(const file of api.files){const aliases=byPhysical.get(file.path)??[];aliases.push(file.logicalPath);byPhysical.set(file.path,aliases);}
 for(const[path,aliases]of byPhysical)if(aliases.length>1)gaps.push({kind:'multiple-native-logical-aliases',path,aliases});
 const implementation=api.files.filter(row=>!row.external&&!row.defaultLibrary&&!row.declaration&&!row.path.endsWith('.json')).map(row=>row.logicalPath),owned=new Set(implementation);
 const observedEdges=api.observations.filter(row=>row.target&&loaded.has(row.target.logicalPath)).map(row=>({from:row.from,to:row.target.logicalPath}));
 const components=stronglyConnected(implementation,observedEdges.filter(edge=>owned.has(edge.from)&&owned.has(edge.to)));
 const oversizedObservedComponents=components.filter(rows=>rows.length>REFERENCE_LIMITS.ownedClosure).map(members=>({members,count:members.length}));
 gaps.push({kind:'complete-effective-context-graph-and-native-context-controls-open'});
 return{orderedInventoryComplete:true,graphComplete:false,planFeasible:false,compilerQualified:false,reasons:reasonObservations,gaps,
  observedImplementationComponents:components,oversizedObservedComponents,
  componentMeaning:'Direct observed implementation SCCs only; context-mediated edges and native global ownership remain open; not a packing plan'};
}
export function compareAvailableContext(before,after){
 assert.equal(before.kind,'STABLE_AVAILABLE_PACKAGE_CONTEXT_NOT_NATIVE_READ_TRACE');assert.equal(after.kind,before.kind);
 // Iteration order and unrelated cache-file counts are not native package facts.
 assert(same(before.packages,after.packages)&&same(before.aliases,after.aliases),'Installed package bytes / logical alias context changed');return true;
}
export function assertFixedInventoryConfig(source,path){assert([resolve(source,'tsconfig.json'),resolve(source,'tsconfig.build.json')].includes(path));assert(!isAbsolute(relative(source,path)));}
