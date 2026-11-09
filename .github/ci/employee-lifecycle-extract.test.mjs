import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {EMPLOYEE_LIFECYCLE_PROFILE} from './employee-lifecycle-profile.mjs';
import {employeeLifecycleMember,readEmployeeLifecycleMembers} from './employee-lifecycle-evidence.mjs';
const row=EMPLOYEE_LIFECYCLE_PROFILE.files[0],descriptor={version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'},unit={id:'db-'+createHash('sha256').update(JSON.stringify({file:row.file,descriptor})).digest('hex').slice(0,16),kind:'db',files:[row.file],singleton:descriptor};
const receiver=fileURLToPath(new URL('./employee-lifecycle-extract.py',import.meta.url));
function fixture(entries,exercise){const directory=mkdtempSync(join(tmpdir(),'employee-archive-model-'));try{
 const archive=join(directory,'owned.zip'),made=spawnSync('/usr/bin/python3',['-I','-B','-c',"import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED); entries=json.loads(sys.argv[2]); [(lambda i,r: (setattr(i,'external_attr',r.get('mode',33152)<<16),z.writestr(i,bytes.fromhex(r['hex']))))(zipfile.ZipInfo(r['name']),r) for r in entries]; z.close()",archive,JSON.stringify(entries)],{encoding:'utf8',timeout:10000});assert.equal(made.status,0,made.stderr);
 const digest='sha256:'+createHash('sha256').update(readFileSync(archive)).digest('hex'),destination=join(directory,'received');
 const receive=(overrides={})=>spawnSync('/usr/bin/python3',['-I','-B',receiver,archive,destination,overrides.unit??unit.id,overrides.file??row.file,overrides.digest??digest],{encoding:'utf8',timeout:10000,maxBuffer:262144});exercise({directory,destination,receive});
 }finally{rmSync(directory,{recursive:true,force:true});}}
const entry=(name,value,mode)=>({name,hex:Buffer.from(value).toString('hex'),...(mode?{mode}:{})});
test('the closed receiver preserves exact binary log bytes and independently lists every member',()=>{
 const filename=row.clockDirectory+'/native-log-part-1.stdout.log.gz',binary=Buffer.from([0,255,10,13,128]);fixture([entry(`unit-${unit.id}.json`,'{}'),entry(filename,binary)],({destination,receive})=>{
  const result=receive();assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout),members=readEmployeeLifecycleMembers(destination,unit);assert.equal(receipt.releaseAuthorized,false);assert.equal(lstatSync(destination).mode&0o7777,0o700);assert.deepEqual(members.get(filename),binary);assert.deepEqual(receipt.members,[...members].map(([name,bytes])=>({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0));
 });
});
test('path, duplicate, link, foreign-unit and unknown-member archives refuse without broadening the legacy extractor',()=>{
 for(const entries of [[entry('../escape.json','{}')],[entry('/absolute.json','{}')],[entry('other/unit.json','{}')],[entry('unit-'+unit.id+'.json','{}'),entry('unit-'+unit.id+'.json','{}')],[entry('unit-'+unit.id+'.json','target',0o120777)],[entry('unit-foreign.json','{}')],[entry('payload.sh','echo private')],[entry(row.clockDirectory+'/native-log-part-129.stdout.log.gz','bytes')]])fixture(entries,({receive})=>assert.notEqual(receive().status,0));
});
test('wrong API byte digest, foreign exact file/unit and receiver reuse cannot become acceptance',()=>{
 for(const overrides of [{digest:'sha256:'+'0'.repeat(64)},{file:EMPLOYEE_LIFECYCLE_PROFILE.files[1].file},{unit:'db-'+'0'.repeat(16)}])fixture([entry('unit-'+unit.id+'.json','{}')],({receive})=>assert.notEqual(receive(overrides).status,0));
 fixture([entry('unit-'+unit.id+'.json','{}')],({receive})=>{assert.equal(receive().status,0);assert.notEqual(receive().status,0);});
});
test('member grammar is closed for all five units and never treats foreign roots or ready contents as proof',()=>{
 for(const profile of EMPLOYEE_LIFECYCLE_PROFILE.files){const current={...unit,files:[profile.file]};assert(employeeLifecycleMember(current,'unit-'+unit.id+'.json'));assert(!employeeLifecycleMember(current,'../unit-'+unit.id+'.json'));assert(!employeeLifecycleMember(current,'unit-other.json'));assert(!employeeLifecycleMember(current,'unregistered/report.json'));if(profile.clockDirectory){assert(employeeLifecycleMember(current,profile.clockDirectory+'/benchmark-clock.json.ready',true));assert(!employeeLifecycleMember(current,profile.clockDirectory+'/benchmark-clock.json.ready/foreign.json'));}}
});
