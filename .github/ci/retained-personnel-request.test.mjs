import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {retainedPersonnelRequest,RETAINED_PERSONNEL_FILE as file} from './retained-personnel-request.mjs';
const yes={AIHR_RETAINED_PERSONNEL_MILLION:'true',AIHR_RETAINED_PERSONNEL_TYPECHECK:'true',AIHR_EVAL_MODEL:''};
test('ordinary focused requests keep their original lane; million rows require explicit admission',()=>{
 assert.equal(retainedPersonnelRequest({},['test/ai-workspace.test.ts']),false);
 assert.throws(()=>retainedPersonnelRequest({},[file]));
 assert.equal(retainedPersonnelRequest(yes,[file]),true);
});
test('refuses other suites, mixed suites, missing compiler, malformed flags and any model request',()=>{
 for(const files of [['test/ai-workspace.test.ts'],[file,'test/ai-workspace.test.ts'],[]])assert.throws(()=>retainedPersonnelRequest(yes,files));
 assert.throws(()=>retainedPersonnelRequest({...yes,AIHR_RETAINED_PERSONNEL_TYPECHECK:'false'},[file]));
 assert.throws(()=>retainedPersonnelRequest({...yes,AIHR_RETAINED_PERSONNEL_MILLION:'TRUE'},[file]));
 assert.throws(()=>retainedPersonnelRequest({...yes,AIHR_EVAL_MODEL:'a-model'},[file]));
});
test('only the opt-in focused native job receives the longer fixture envelope and no new provider secret',()=>{
 const w=readFileSync(new URL('../workflows/alpha-focused-checks.yml',import.meta.url),'utf8');
 assert.match(w,/inputs\.retained_personnel_million && 40 \|\| 20/);
 assert.match(w,/AIHR_RETAINED_PERSONNEL_MILLION: \$\{\{ inputs\.retained_personnel_million \}\}/);
 assert.match(w,/AIHR_RETAINED_PERSONNEL_TYPECHECK: \$\{\{ inputs\.run_typecheck \}\}/);
 const core=readFileSync(new URL('./focused-checks.mjs',import.meta.url),'utf8');
 assert.equal((core.match(/retainedPersonnelRequest\(process\.env, files\)/g)??[]).length,2);
});
