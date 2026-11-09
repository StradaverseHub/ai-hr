/** Closed source member grammar/byte map only; API provenance is separate. */
import assert from 'node:assert/strict';
import {readFileSync,openSync,fstatSync,lstatSync,readSync,closeSync,readdirSync,constants,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
export const EMPLOYEE_EVIDENCE_PROFILE=Object.freeze(JSON.parse(readFileSync(new URL('./employee-lifecycle-evidence-profile.json',import.meta.url))));
export function employeeLifecycleMember(unit,name,directory=false){
 const profile=employeeLifecycleUnit(unit),rule=EMPLOYEE_EVIDENCE_PROFILE;if(!profile||typeof name!=='string'||name.includes('\\')||name.includes('\0')||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))return false;
 if(directory)return name===profile.clockDirectory||!!profile.clockDirectory&&rule.clockNames.some(clock=>name===profile.clockDirectory+'/'+clock+'.ready');
 if(rule.rootNames.some(value=>name===value.replaceAll('{UNIT}',unit.id)))return true;
 for(const prefix of rule.sequencePrefixes){const value=prefix.replaceAll('{UNIT}',unit.id);if(name.startsWith(value)&&/^[1-9][0-9]?\.json$/.test(name.slice(value.length))&&Number(name.slice(value.length,-5))<=rule.sequenceMaximum)return true;}
 if(!profile.clockDirectory||!name.startsWith(profile.clockDirectory+'/'))return false;
 const base=name.slice(profile.clockDirectory.length+1);if(base.includes('/'))return false;
 if(rule.clockNames.includes(base)||base===rule.reportByStage[profile.stage])return true;
 return profile.planPhases===44&&(rule.planNames.includes(base)||/^native-log-part-([1-9][0-9]{0,2})\.(?:stdout|stderr)\.log\.gz$/.test(base)&&Number(base.split('-')[3].split('.')[0])<=rule.gzipParts);
}
/** Owned receiver directory only; no source paths are taken from JSON evidence. */
export function readEmployeeLifecycleMembers(directory,unit){
 assert(employeeLifecycleUnit(unit));assert.equal(realpathSync(directory),directory);
 const original=lstatSync(directory);assert(original.isDirectory()&&!original.isSymbolicLink()&&original.uid===process.getuid()&&(original.mode&0o7777)===0o700);
 const members=new Map();let total=0,count=0;
 const same=(before,after)=>['dev','ino','mode','uid','size','mtimeMs','ctimeMs'].every(key=>before[key]===after[key]);
 function visit(path,prefix=''){
  for(const base of readdirSync(path)){
   const name=prefix+base,file=join(path,base),before=lstatSync(file);assert(++count<=EMPLOYEE_EVIDENCE_PROFILE.entries&&!before.isSymbolicLink());
   if(before.isDirectory()){assert(before.uid===original.uid&&(before.mode&0o7777)===0o700&&employeeLifecycleMember(unit,name,true));visit(file,name+'/');assert(same(before,lstatSync(file)));continue;}
   assert(employeeLifecycleMember(unit,name)&&before.isFile()&&before.nlink===1&&before.uid===original.uid&&(before.mode&0o7777)===0o600&&before.size<=EMPLOYEE_EVIDENCE_PROFILE.memberBytes);
   const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    assert(same(before,fstatSync(fd)));const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);assert(n>0);offset+=n;}
    assert.equal(readSync(fd,Buffer.alloc(1),0,1,null),0);assert(same(before,fstatSync(fd))&&same(before,lstatSync(file)));
    total+=bytes.length;assert(total<=EMPLOYEE_EVIDENCE_PROFILE.expandedBytes&&!members.has(name));members.set(name,bytes);
   }finally{closeSync(fd);}
  }
 }
 visit(directory);assert(same(original,lstatSync(directory)));return members;
}
