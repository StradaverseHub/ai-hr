/** Real filesystem report-inventory controls, not native/API/test acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,rmdirSync,symlinkSync,linkSync,renameSync,truncateSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readUnitReportDirectories,UNIT_REPORT_DIRECTORY_BOUNDS} from './unit-report-directories.mjs';
import {EMPLOYEE_LIFECYCLE_PROFILE} from './employee-lifecycle-profile.mjs';
import {selectCommissioning,summarizeCommissioning} from './singleton-commissioning.mjs';
const descriptor={version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'},file=EMPLOYEE_LIFECYCLE_PROFILE.files[0].file;
const employee={id:'db-'+createHash('sha256').update(JSON.stringify({file,descriptor})).digest('hex').slice(0,16),kind:'db',files:[file],singleton:descriptor};
const ordinary={id:'nodb-'+'a'.repeat(16),kind:'nodb',files:['test/fictional.test.ts']},browser={id:'browser-chromium',kind:'browser',files:['test/fictional.browser.test.tsx']},native={id:'nodb-'+'b'.repeat(16),kind:'nodb',files:['test/runtime-ready-admission-native.test.ts'],singleton:{version:1,profile:'linux-systemd-nginx-v1',workers:1,isolation:'job-host'}};
function fixture(work){const root=realpathSync(mkdtempSync(join(tmpdir(),'ci-report-inventory-')));try{work(root);}finally{rmSync(root,{recursive:true,force:true});}}
const folder=(root,unit,mode)=>join(root,(mode==='full'?'unit-':'commission-unit-')+unit.id);
function make(root,unit,mode='full'){const path=folder(root,unit,mode);mkdirSync(path);writeFileSync(join(path,'unit-'+unit.id+'.json'),JSON.stringify({id:unit.id,fictional:true}));return path;}
const read=(root,units,mode='full')=>[...readUnitReportDirectories(root,units,{mode})];
const refused=work=>assert.throws(work,/CI artifact report-directory custody refused/);
test('full inventory retains ordinary, browser, legacy native and employee units with legitimate ancillary evidence',()=>fixture(root=>{
 const units=[ordinary,browser,native,employee];for(const unit of units){const path=make(root,unit);for(const name of ['health-before.json','pdf-tools-setup.json','role-receipt.json','native-preparation.json'])writeFileSync(join(path,name),Buffer.from([255,0,128]));}
 const path=folder(root,employee,'full'),clock=join(path,EMPLOYEE_LIFECYCLE_PROFILE.files[0].clockDirectory);mkdirSync(clock);mkdirSync(join(clock,'benchmark-clock.json.ready'));writeFileSync(join(clock,'native-log-part-1.stdout.log.gz'),Buffer.from([31,139,255]));
 const rows=read(root,units);assert.deepEqual(rows.map(row=>row.report.id).sort(),units.map(unit=>unit.id).sort());for(const row of rows)assert.deepEqual(JSON.parse(row.bytes),row.report);
}));
test('full mode requires exactly every planned artifact directory and never ignores a foreign substitute',()=>fixture(root=>{
 make(root,ordinary);refused(()=>read(root,[ordinary,browser]));make(root,browser);read(root,[ordinary,browser]);mkdirSync(join(root,'unit-foreign'));refused(()=>read(root,[ordinary,browser]));
 rmdirSync(join(root,'unit-foreign'));renameSync(folder(root,browser,'full'),join(root,'unit-foreign'));refused(()=>read(root,[ordinary,browser]));
}));
test('commissioning admits only a selected subset and the actual summary retains missing instead of verified',()=>fixture(root=>{
 const plan={sha:'a'.repeat(40),controller:'b'.repeat(40),migrationBase:'c'.repeat(40),fingerprint:'d'.repeat(64),units:[employee]},selection=selectCommissioning(plan,[employee.id]);
 const entries=read(root,[employee],'commissioning');assert.deepEqual(entries,[]);const summary=summarizeCommissioning(plan,selection,entries,{runId:123,attempt:1});assert.deepEqual(summary.outcomes,[{id:employee.id,outcome:'missing'}]);assert.equal(summary.selectedProfilesVerified,false);assert.equal(summary.completeSuite,false);assert.equal(summary.releaseAuthorized,false);
 const path=make(root,employee,'commissioning');rmSync(join(path,'unit-'+employee.id+'.json'));writeFileSync(join(path,'health.json'),'{}');assert.deepEqual(read(root,[employee],'commissioning'),[]);
 mkdirSync(join(root,'commission-unit-foreign'));refused(()=>read(root,[employee],'commissioning'));
}));
test('foreign or duplicate-ID report names inside any selected artifact refuse before even the first report is yielded',()=>{
 for(const mode of ['full','commissioning'])fixture(root=>{
  const first=make(root,ordinary,mode),second=make(root,browser,mode);writeFileSync(join(second,'unit-'+ordinary.id+'.json'),JSON.stringify({id:ordinary.id}));
  const iterator=readUnitReportDirectories(root,[ordinary,browser],{mode});refused(()=>iterator.next());
  rmSync(join(second,'unit-'+ordinary.id+'.json'));writeFileSync(join(first,'unit-foreign.json'),'{}');refused(()=>read(root,[ordinary,browser],mode));
 });
});
test('nested matching or foreign reports refuse even when commissioning has no root-level report',()=>{
 for(const mode of ['full','commissioning'])fixture(root=>{
  const path=make(root,ordinary,mode),nested=join(path,'extra');mkdirSync(nested);writeFileSync(join(nested,'unit-'+ordinary.id+'.json'),JSON.stringify({id:ordinary.id}));refused(()=>read(root,[ordinary],mode));
  rmSync(join(path,'unit-'+ordinary.id+'.json'));refused(()=>read(root,[ordinary],mode));
 });
});
test('symlink root, artifact directory, report and ancillary member cannot be followed as report custody',()=>fixture(root=>{
 const directory=join(root,'received');mkdirSync(directory);const path=make(directory,ordinary),foreign=join(root,'foreign');mkdirSync(foreign);writeFileSync(join(foreign,'private.json'),'private material must never be classified');
 const alias=join(root,'alias');symlinkSync(directory,alias);refused(()=>read(alias,[ordinary]));
 for(const name of ['unit-'+ordinary.id+'.json','health.json']){const target=join(path,name);rmSync(target,{force:true});symlinkSync(join(foreign,'private.json'),target);refused(()=>read(directory,[ordinary]));rmSync(target);writeFileSync(join(path,'unit-'+ordinary.id+'.json'),JSON.stringify({id:ordinary.id}));}
 rmSync(path,{recursive:true});symlinkSync(foreign,path);refused(()=>read(directory,[ordinary]));
}));
test('hardlinked, directory-shaped, empty or oversized matching reports refuse without loading oversized contents',()=>fixture(root=>{
 const path=make(root,ordinary),report=join(path,'unit-'+ordinary.id+'.json'),alias=join(path,'aliased.json');linkSync(report,alias);refused(()=>read(root,[ordinary]));rmSync(alias);rmSync(report);mkdirSync(report);refused(()=>read(root,[ordinary]));rmdirSync(report);writeFileSync(report,'');refused(()=>read(root,[ordinary]));truncateSync(report,UNIT_REPORT_DIRECTORY_BOUNDS.memberBytes+1);refused(()=>read(root,[ordinary]));
}));
test('malformed UTF8, JSON and an ID that differs from its exact report filename refuse',()=>fixture(root=>{
 const path=make(root,ordinary),report=join(path,'unit-'+ordinary.id+'.json');
 for(const bytes of [Buffer.from([255]),Buffer.from('{"private":"truncated'),Buffer.from(JSON.stringify({id:browser.id})),Buffer.from('null')]){writeFileSync(report,bytes);refused(()=>read(root,[ordinary]));}
}));
test('metadata traversal preserves declared64MiB members and100/256 entry limits without reading ancillary contents',()=>{
 for(const unit of [ordinary,employee])fixture(root=>{
  const path=make(root,unit),maximum=unit===employee?256:100;
  for(let n=1;n<maximum;n++)writeFileSync(join(path,'ancillary-'+n+'.json'),Buffer.from([255]));
  const large=join(path,'ancillary-1.json');truncateSync(large,UNIT_REPORT_DIRECTORY_BOUNDS.memberBytes);chmodSync(large,0o000);assert.equal(read(root,[unit]).length,1);
  writeFileSync(join(path,'one-too-many.json'),'');refused(()=>read(root,[unit]));
 });
});
test('a report replacement after complete inventory and the first yield refuses before a successor can qualify',()=>fixture(root=>{
 make(root,ordinary);const path=make(root,browser),report=join(path,'unit-'+browser.id+'.json'),iterator=readUnitReportDirectories(root,[ordinary,browser],{mode:'full'});
 const first=iterator.next();assert.equal(first.done,false);const other=first.value.report.id===browser.id?join(folder(root,ordinary,'full'),'unit-'+ordinary.id+'.json'):report;
 renameSync(other,other+'.prior');writeFileSync(other,JSON.stringify({id:'foreign'}));refused(()=>iterator.next());
}));
test('a late extra report or replaced artifact root refuses final consumption instead of producing a terminal inventory',()=>{
 for(const change of ['extra','root'])fixture(root=>{
  const received=join(root,'received');mkdirSync(received);const path=make(received,ordinary),iterator=readUnitReportDirectories(received,[ordinary],{mode:'full'});assert.equal(iterator.next().done,false);
  if(change==='extra')writeFileSync(join(path,'unit-foreign.json'),'{}');else{renameSync(received,received+'.prior');mkdirSync(received);make(received,ordinary);}
  refused(()=>iterator.next());
 });
});
test('closed modes, unit IDs, duplicate expectations and declared cardinality limits cannot redefine the inventory',()=>fixture(root=>{
 for(const [units,mode]of [[[ordinary],'other'],[[],'full'],[[ordinary,ordinary],'full'],[[{...ordinary,id:'../foreign'}],'full'],[[{...ordinary,id:ordinary.id+'\n'}],'full'],[Array.from({length:257},(_,n)=>({...ordinary,id:'nodb-'+n.toString(16).padStart(16,'0')})),'full'],[Array.from({length:17},(_,n)=>({...ordinary,id:'nodb-'+n.toString(16).padStart(16,'0')})),'commissioning']])refused(()=>read(root,units,mode));
}));
