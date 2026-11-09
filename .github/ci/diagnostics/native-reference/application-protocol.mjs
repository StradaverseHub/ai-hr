/** Metadata interpretation only. Unknown native context never grants coverage. */
import assert from 'node:assert/strict';
import {resolve,isAbsolute,relative} from 'node:path';
import {stronglyConnected,REFERENCE_LIMITS} from './graph.mjs';
import {APPLICATION_INPUT_LIMITS} from './application-inputs.mjs';
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

// This deliberately compares file/family cardinalities only. Neither repeated
// CLI text nor agreeing order proves which original parser occurrence it names.
function cliReasonKind(text){
 if(text.startsWith('Imported via '))return 3;
 if(text.startsWith('Referenced via '))return 4;
 if(text.startsWith('Type library referenced via '))return 5;
 if(text.startsWith('Library referenced via '))return 7;
 if(text.startsWith('Entry point of type library ')||text.startsWith('Entry point for implicit type library '))return 8;
 if(/^(Default library(?: |$)|Library .+ specified in compilerOptions$)/.test(text))return 6;
 if(/^(Matched by (?:include|default include) pattern |Part of .files. list |Root file specified for compilation$)/.test(text))return 0;
 if(text.startsWith('Source from referenced project '))return 1;
 if(text.startsWith('Output from referenced project '))return 2;
 if(text.startsWith('File redirects to file ')||text.startsWith('File is output of project reference source ')||/^File is (?:ECMAScript|CommonJS) module because /.test(text))return 'annotation';
 return 'unknown';
}

export function compareNativeInclusion(cli,native){
 assert.equal(native.kind,'PINNED_TS593_READ_ONLY_PROGRAM_INCLUSION');
 assert(Array.isArray(native.files)&&native.files.length===cli.length&&Array.isArray(native.stores)&&Array.isArray(native.automaticTypes));
 const disagreements=[],nativeCounts=Array(9).fill(0),cliCounts=Array(9).fill(0);let annotations=0,unknown=0;
 const knownIndex=(index,items)=>Number.isSafeInteger(index)&&index>=0&&index<items.length;
 const selectedIndex=index=>index===null||knownIndex(index,native.files);
 let targetDisagreements=0,comparedRows=0;
 const compareTarget=(selected,reported,file)=>{
  assert(selectedIndex(selected)&&reported===(selected===file),'Invalid native inclusion target linkage');
  if(!reported)targetDisagreements++;
 };
 for(let file=0;file<cli.length;file++){
  const observed=native.files[file],stock=cli[file],nativeByKind=Array(9).fill(0),stockByKind=Array(9).fill(0);
  assert.equal(observed.logicalPath,stock.logicalPath,'Native inclusion / CLI ordered membership mismatch');
  assert(Array.isArray(observed.reasons)&&observed.reasons.length>0);
  comparedRows+=observed.reasons.length+stock.reasons.length;
  assert(comparedRows<=APPLICATION_INPUT_LIMITS.metadataEntries,'Native inclusion comparison metadata bound');
  for(const row of observed.reasons){
   const{kind}=row;assert(Number.isSafeInteger(kind)&&kind>=0&&kind<=8);nativeByKind[kind]++;nativeCounts[kind]++;
   if(kind===8){assert(knownIndex(row.automatic,native.automaticTypes));compareTarget(native.automaticTypes[row.automatic].target?.loadedFile??null,row.storedTargetMatchesReason,file);}
   if(![3,4,5,7].includes(kind))continue;
   assert(knownIndex(row.from,native.files)&&Number.isSafeInteger(row.index)&&row.index>=0&&typeof row.name==='string');
   if(row.synthetic===true)assert(kind===3&&row.pos===-1&&row.end===-1,'Invalid compiler-generated reference position');
   else assert(row.synthetic===false&&Number.isSafeInteger(row.pos)&&Number.isSafeInteger(row.end)&&row.pos>=0&&row.pos<row.end,'Invalid authored reference position');
   if(kind===3||kind===5){
    assert(knownIndex(row.stored,native.stores));const stored=native.stores[row.stored];
    assert((row.mode===null||row.mode===1||row.mode===99)&&stored.file===row.from&&stored.name===row.name&&stored.mode===row.mode&&stored.kind===(kind===3?'resolvedModule':'resolvedTypeReferenceDirective'),'Invalid native resolution key linkage');
    compareTarget(stored.target?.loadedFile??null,row.storedTargetMatchesReason,file);
   }else compareTarget(row.selectedLoadedFile,row.selectedTargetMatchesReason,file);
  }
  for(const text of stock.reasons){const kind=cliReasonKind(text);if(kind==='annotation')annotations++;else if(kind==='unknown')unknown++;else{stockByKind[kind]++;cliCounts[kind]++;}}
  if(!same(nativeByKind,stockByKind))disagreements.push({file,nativeByKind,stockByKind});
 }
 return{kind:'NATIVE_INCLUSION_AND_STOCK_CLI_FAMILY_COUNTS',nativeCounts,cliCounts,annotations,unknown,disagreements,targetDisagreements,
  fileFamilyCountsAgree:disagreements.length===0&&unknown===0,exactOrderedReasonTextCompared:false,cliOccurrencePairsAssigned:false,freshFirstLoadsObserved:false};
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
 if(api.kind==='ACTUAL_UNMODIFIED_DEFAULT_APPLICATION_PROGRAM_METADATA')assert(api.nativeInclusion,'Pinned native inclusion observation required');
 const inclusionComparison=api.nativeInclusion?compareNativeInclusion(cli,api.nativeInclusion):null;
 gaps.push({kind:'complete-effective-context-graph-and-native-context-controls-open'});
 return{orderedInventoryComplete:true,graphComplete:false,planFeasible:false,compilerQualified:false,reasons:reasonObservations,gaps,inclusionComparison,
  observedImplementationComponents:components,oversizedObservedComponents,
  componentMeaning:'Direct observed implementation SCCs only; context-mediated edges and native global ownership remain open; not a packing plan'};
}
export function compareAvailableContext(before,after){
 assert.equal(before.kind,'STABLE_AVAILABLE_PACKAGE_CONTEXT_NOT_NATIVE_READ_TRACE');assert.equal(after.kind,before.kind);
 // Iteration order and unrelated cache-file counts are not native package facts.
 assert(same(before.packages,after.packages)&&same(before.aliases,after.aliases),'Installed package bytes / logical alias context changed');return true;
}
export function assertFixedInventoryConfig(source,path){assert([resolve(source,'tsconfig.json'),resolve(source,'tsconfig.build.json')].includes(path));assert(!isAbsolute(relative(source,path)));}
