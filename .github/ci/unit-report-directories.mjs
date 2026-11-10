/** Finite local REPORT inventory. API/ZIP/source/test authentication remains
 * with the existing owners. Only the fixed workload member adds a descriptor read. */
import {constants,openSync,closeSync,fstatSync,lstatSync,opendirSync,readSync,realpathSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
import {EMPLOYEE_EVIDENCE_PROFILE} from './employee-lifecycle-evidence.mjs';
import {nativeWorkloadDatabaseUnit,NATIVE_WORKLOAD_DATABASE_MEMBER,NATIVE_WORKLOAD_DATABASE_MEMBER_MAX} from './singleton-protocol.mjs';
// Existing legacy extract-artifact.py bounds; employee bounds retain its reviewed
// 256-entry binary/native receiver. No smaller arbitrary cap replaces either.
export const UNIT_REPORT_DIRECTORY_BOUNDS=Object.freeze({units:256,commissioning:16,legacyEntries:100,memberBytes:64*1024*1024,expandedBytes:128*1024*1024});
const fail=()=>{throw Error('CI artifact report-directory custody refused');};
const require=value=>{if(!value)fail();};
const fields=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
const equal=(a,b)=>fields.every(key=>a[key]===b[key]);
const stat=path=>lstatSync(path,{bigint:true});
const same=(path,before)=>{const now=stat(path);require(!now.isSymbolicLink()&&equal(before,now));};
function directory(path){
 const before=stat(path);require(before.isDirectory()&&!before.isSymbolicLink()&&before.uid===BigInt(process.getuid()));
 const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{require(equal(before,fstatSync(fd,{bigint:true})));same(path,before);return before;}finally{closeSync(fd);}
}
function names(path,birth,maximum){
 const handle=opendirSync(path,{bufferSize:1}),result=[];
 try{for(;;){const entry=handle.readSync();if(entry===null)break;require(result.length<maximum);result.push(entry.name);}}
 finally{handle.closeSync();}
 same(path,birth);return result;
}
function readMember({path,birth}){
 require(birth.size>0n);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  require(equal(birth,fstatSync(fd,{bigint:true})));const raw=Buffer.alloc(Number(birth.size));let offset=0;
  while(offset<raw.length){const n=readSync(fd,raw,offset,raw.length-offset,null);require(n>0);offset+=n;}
  require(readSync(fd,Buffer.alloc(1),0,1,null)===0);require(equal(birth,fstatSync(fd,{bigint:true})));same(path,birth);
  return raw;
 }finally{closeSync(fd);}
}
/** Each yielded entry is an actual bounded descriptor read. Complete consumption
 * is required by both callers before publishing any summary or CI receipt. */
export function* readUnitReportDirectories(root,units,{mode}={}){
 require(mode==='full'||mode==='commissioning');yield* scan(root,units,mode);
}
/** Release has already authenticated this unit's exact API ZIP and extracted it
 * into its own directory. Re-read the same closed member, never a cached receipt. */
export function readWorkloadDatabaseArtifact(root,unit){
 require(nativeWorkloadDatabaseUnit(unit));const [entry]=[...scan(root,[unit],'workload-archive')];return entry;
}
function* scan(root,units,mode){
 require(typeof root==='string'&&resolve(root)===root&&realpathSync(root)===root);
 require(Array.isArray(units)&&units.length>0&&units.length<=(mode==='full'?UNIT_REPORT_DIRECTORY_BOUNDS.units:UNIT_REPORT_DIRECTORY_BOUNDS.commissioning));
 const archive=mode==='workload-archive',prefix=mode==='commissioning'?'commission-unit-':'unit-',expected=new Map();
 for(const unit of units){require(unit&&typeof unit.id==='string'&&/^(?:(?:nodb|db)-[a-f0-9]{16}|browser-(?:chromium|firefox|webkit))(?![\s\S])/.test(unit.id));require(!expected.has(prefix+unit.id));expected.set(prefix+unit.id,unit);}
 const rootBirth=directory(root),folders=archive?[basename(root)]:names(root,rootBirth,expected.size);
 require(folders.every(name=>expected.has(name)));
 if(mode==='full')require(folders.length===expected.size); // commissioning subset stays explicitly missing
 const trees=[];
 // Scan EVERY member in every present expected artifact before yielding a report.
 // A foreign/duplicate/nested report cannot disappear into plan.units.map().
 for(const name of folders){
  same(root,rootBirth);const unit=expected.get(name),path=archive?root:join(root,name),employee=employeeLifecycleUnit(unit),workload=nativeWorkloadDatabaseUnit(unit);
  const entryLimit=employee?EMPLOYEE_EVIDENCE_PROFILE.entries:UNIT_REPORT_DIRECTORY_BOUNDS.legacyEntries;
  let entries=0,total=0n,report,workloadMember;const snapshots=[];
  function walk(current,relative=''){
   const birth=directory(current);snapshots.push({path:current,birth});const children=names(current,birth,entryLimit-entries);
   for(const base of children){
    require(base!=='.'&&base!=='..'&&!base.includes('\\')&&!base.includes('\0')&&++entries<=entryLimit);
    const file=join(current,base),child=stat(file);require(!child.isSymbolicLink()&&child.uid===rootBirth.uid);
    const reportName=base.startsWith('unit-')&&base.endsWith('.json');
    if(reportName){require(relative===''&&base==='unit-'+unit.id+'.json'&&!report);require(child.isFile());report={path:file,birth:child};}
    if(workload&&base===NATIVE_WORKLOAD_DATABASE_MEMBER){
     require(relative===''&&!workloadMember&&child.isFile()&&child.size>0n&&child.size<=BigInt(NATIVE_WORKLOAD_DATABASE_MEMBER_MAX));
     workloadMember={path:file,birth:child};
    }
    if(child.isDirectory())walk(file,relative+base+'/');
    else{
     require(child.isFile()&&child.nlink===1n&&child.size>=0n&&child.size<=BigInt(UNIT_REPORT_DIRECTORY_BOUNDS.memberBytes));
     total+=child.size;require(total<=BigInt(UNIT_REPORT_DIRECTORY_BOUNDS.expandedBytes));snapshots.push({path:file,birth:child});
    }
   }
   same(current,birth);
  }
  walk(path);same(root,rootBirth);
  if(mode==='full'||archive)require(report!==undefined);
  trees.push({unit,snapshots,report,workloadMember});
 }
 function unchanged(tree){same(root,rootBirth);for(const {path,birth}of tree.snapshots)same(path,birth);}
 for(const tree of trees){
  unchanged(tree);if(!tree.report)continue;
  const raw=readMember(tree.report),workloadDatabaseBytes=tree.workloadMember?readMember(tree.workloadMember):undefined;
  unchanged(tree);const bytes=raw.toString('utf8');require(Buffer.from(bytes,'utf8').equals(raw));
  let report;try{report=JSON.parse(bytes);}catch{fail();}
  require(report&&typeof report==='object'&&!Array.isArray(report)&&report.id===tree.unit.id);
  yield{bytes,report,...(workloadDatabaseBytes?{workloadDatabaseBytes}:{})};unchanged(tree);
 }
 for(const tree of trees)unchanged(tree);same(root,rootBirth);
}
