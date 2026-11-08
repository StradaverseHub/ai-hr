import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,realpathSync,mkdtempSync,mkdirSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {employeeChoiceRestorationSourceInverse} from '../../test/performance/employee-choice-restoration-source.ts';
import {createHash} from 'node:crypto';
import {EMPLOYEE_LIFECYCLE_PROFILE} from './employee-lifecycle-profile.mjs';
import {EMPLOYEE_LIFECYCLE_SOURCES,assertEmployeeLifecycleSourceClosure} from './employee-lifecycle-sources.mjs';
import {singletonSources} from './singleton-protocol.mjs';
const candidateRoot=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const journal=JSON.parse(readFileSync(new URL('../../db/migrations/meta/_journal.json',import.meta.url),'utf8'));
const independentOwners=[".github/ci/employee-restoration-proof.mjs","test/employee-choice-restoration-proof.test.ts","test/performance/employee-choice-restoration-cleanup.ts","test/performance/employee-choice-restoration-source.ts","docs/qualification/employee-native-restoration-inverse-20261108.json",'.github/ci/unit-report-directories.mjs','.github/ci/unit-report-directories.test.mjs','test/ci-unit-report-directory-contract.test.ts','.github/ci/run-unit.mjs','.github/ci/employee-lifecycle.mjs','.github/ci/employee-lifecycle-profile.json','.github/ci/employee-lifecycle-context.mjs','.github/ci/employee-lifecycle-supervisor.py','.github/ci/employee-lifecycle-always-stop.mjs','.github/ci/employee-postgres-policy.py','.github/ci/employee-postgres-resource.py','.github/ci/owned-process.py','.github/ci/employee-lifecycle-api.mjs','.github/ci/employee-lifecycle-evidence.mjs','.github/ci/employee-lifecycle-extract.py','.github/ci/employee-lifecycle-witness.mjs','.github/ci/employee-lifecycle-native.mjs','.github/ci/employee-native-log-codec.mjs','.github/ci/release-ci.mjs','.github/ci/verify-shards.mjs','test/performance/employee-choice-lifecycle-admission.ts','test/helpers/ci-singleton-admission.ts','test/harness.ts','db/client.ts','db/schema.ts','db/migrations/meta/_journal.json','test/fixtures/employee-choice-native-purpose.sql','test/fixtures/employee-choice-exact-ascii-purpose.sql','core/employee-choice.ts','lib/hr-date.ts'];
independentOwners.push("core/employee-choice-ascii.ts","test/performance/employee-choice-benchmark-contract.ts","test/performance/employee-choice-benchmark-harness.ts",".github/ci/employee-ascii-compiled-source.mjs",".github/ci/employee-ascii-compiled-source.test.mjs",".github/ci/employee-ascii-runtime-qualification.mjs",".github/ci/employee-ascii-runtime-qualification.test.mjs","test/employee-ascii-runtime-qualification-model.test.ts","test/employee-choice-inline-ascii-native.test.ts","test/fixtures/employee-choice-ascii-proof-native.ts","test/fixtures/employee-choice-ascii-observation.ts","test/fixtures/employee-choice-ascii-proof-lifetime.ts","test/fixtures/employee-choice-ascii-scalar-corpus.sql","test/fixtures/employee-choice-ascii-vectors.sql","test/employee-choice-exact-ascii-proof.test.ts","test/employee-choice-ascii-observation.test.ts","test/fixtures/unicode-17.0.0/LICENSE.txt","test/fixtures/unicode-17.0.0/UnicodeData.txt","test/fixtures/unicode-17.0.0/SpecialCasing.txt",".github/ci/focused-checks.mjs",".github/workflows/alpha-focused-checks.yml");
independentOwners.push(".github/ci/restricted-port-qualification.mjs",".github/ci/diagnostics/native-reference/admission.mjs","lib/ai/centre-activity.ts","core/ai-centre-control.ts","lib/ai/management-sections.ts");
independentOwners.push('.github/ci/compiler-file-window-inverse.json');
const fingerprint=paths=>createHash('sha256').update(JSON.stringify(paths.map(file=>[file,'c'.repeat(64)]))).digest('hex');
test('all five source-registered units retain the actual canonical SQL history and one complete source owner',()=>{
 for(const row of EMPLOYEE_LIFECYCLE_PROFILE.files){const unit={id:'db-'+'a'.repeat(16),kind:'db',files:[row.file],singleton:{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'}},sources=singletonSources(unit,candidateRoot);assert.equal(new Set(sources).size,sources.length);assertEmployeeLifecycleSourceClosure(sources,journal);for(const owner of independentOwners)assert(sources.includes(owner));for(const entry of journal.entries)assert(sources.includes('db/migrations/'+entry.tag+'.sql'));for(const file of ['db/migrations/2301_attendance_workflow_submission_shared_lock.sql','db/migrations/3103_access_editor_presentation.sql'])assert(sources.includes(file));}
});
test('coherently rehashed missing critical owners or canonical SQL still refuse independently',()=>{
 const file='.github/ci/employee-lifecycle-sources.test.mjs',current=readFileSync(new URL('./employee-lifecycle-sources.test.mjs',import.meta.url),'utf8');
 const original=employeeChoiceRestorationSourceInverse(file,current);assert.equal(Buffer.byteLength(original),3512);assert.equal(createHash('sha256').update(original).digest('hex'),'73ace5ecae2b8ae8321233ce48b99b94e5dcd0734d7fb88cf0bc1d05e2f6d196');
 assert.throws(()=>employeeChoiceRestorationSourceInverse(file,current+'\n'),/current source changed/);
 const unit={id:'db-'+'a'.repeat(16),kind:'db',files:[EMPLOYEE_LIFECYCLE_PROFILE.files[0].file],singleton:{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'}},complete=singletonSources(unit,candidateRoot);
 assertEmployeeLifecycleSourceClosure(complete,journal);
 for(const missing of [...independentOwners,'db/migrations/'+journal.entries[0].tag+'.sql','db/migrations/'+journal.entries.at(-1).tag+'.sql']){
  assert(complete.includes(missing),missing);const reduced=complete.filter(file=>file!==missing);
  assert.equal(reduced.length,complete.length-1);assert(!reduced.includes(missing));assert.notEqual(fingerprint(reduced),fingerprint(complete));assert.throws(()=>assertEmployeeLifecycleSourceClosure(reduced,journal));
 }
});
test('duplicated sources and malformed/duplicated native history cannot redefine the complete closure',()=>{
 assert.throws(()=>assertEmployeeLifecycleSourceClosure([...EMPLOYEE_LIFECYCLE_SOURCES,EMPLOYEE_LIFECYCLE_SOURCES[0]],journal));
 for(const entries of [[],[{tag:'../foreign'}],[journal.entries[0],journal.entries[0]]])assert.throws(()=>assertEmployeeLifecycleSourceClosure(EMPLOYEE_LIFECYCLE_SOURCES,{entries}));
 const unit={id:'db-'+'a'.repeat(16),kind:'db',files:[EMPLOYEE_LIFECYCLE_PROFILE.files[0].file],singleton:{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'}};
 assert.throws(()=>singletonSources(unit));for(const path of ['db/migrations/3500_ai_centre_architecture_compatibility.sql','db/migrations/3501_ai_centre_mandate_write_order.sql'])assert(singletonSources(unit,candidateRoot).includes(path));
 const root=realpathSync(mkdtempSync(join(tmpdir(),'employee-shared-history-model-')));try{
  mkdirSync(join(root,'db/migrations/meta'),{recursive:true});for(const file of readdirSync(join(candidateRoot,'db/migrations')).filter(file=>file.endsWith('.sql')))writeFileSync(join(root,'db/migrations',file),'-- fictional source input\n');
  for(const entries of [[],[{tag:'../foreign'}],[journal.entries[0],journal.entries[0]]]){writeFileSync(join(root,'db/migrations/meta/_journal.json'),JSON.stringify({...journal,entries}));assert.throws(()=>singletonSources(unit,root));}
 }finally{rmSync(root,{recursive:true,force:true});}
});
