/** Pure source/catalog fixtures only. No application, database or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prototypeDefinition,validatePrototypeCatalog,assertInstallEnvironment} from './visibility-plan-prototype.mjs';
const migration=readFileSync(new URL('../../../db/migrations/0515_set_based_visibility.sql',import.meta.url),'utf8');
const definition=()=>prototypeDefinition(migration);
function row(){return {caller:'postgres',owner:'postgres',database:'ai_hr_test_w_plan_proto1',oid:'100',language:'sql',body:definition().original,immutable:{proname:'visible_employment_ids',prokind:'f',provolatile:'s',prosecdef:true,proleakproof:false,proisstrict:false,proretset:false,proparallel:'u',pronargs:0,procost:100,prosqlbody:null,proconfig:['search_path=public'],proowner:'10',proacl:['ai_hr_app=X/postgres']}};}
test('prototype wraps the exact existing predicate without changing one query byte',()=>{
 const d=definition();assert(d.body.includes(d.original.trim().slice(0,-1)));assert(d.sql.includes('LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public'));assert(d.sql.includes('RETURNS uuid[]'));
 assert.throws(()=>prototypeDefinition(migration.replace('SELECT h.employment_id FROM hod h','SELECT h.employment_id FROM hod h WHERE false')));
});
test('only exact known SQL/PLpgSQL definitions and immutable guarded catalog properties are accepted',()=>{
 const d=definition();assert.equal(validatePrototypeCatalog(row(),d,'prototype','ai_hr_test_w_plan_proto1').oid,'100');
 assert.equal(validatePrototypeCatalog({...row(),language:'plpgsql',body:d.body},d,'prototype','ai_hr_test_w_plan_proto1').language,'plpgsql');
 for(const edit of [r=>r.body+=' ',r=>r.language='internal',r=>r.database='ai_hr_test_w1',r=>r.caller='ai_hr_app',r=>r.owner='foreign',r=>r.immutable.prosecdef=false,r=>r.immutable.provolatile='i',r=>r.immutable.proconfig=[],r=>r.immutable.proparallel='s']){const r=row();edit(r);assert.throws(()=>validatePrototypeCatalog(r,d,'prototype','ai_hr_test_w_plan_proto1'));}
 assert.throws(()=>validatePrototypeCatalog({...row(),database:'ai_hr_test_w_plan_base1',language:'plpgsql',body:d.body},d,'baseline','ai_hr_test_w_plan_base1'));
});
test('installer refuses non-hosted, non-owned, mismatched source or shared-database invocation before access',()=>{
 const e={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1',AIHR_PLAN_REUSE_MODE:'prototype',AIHR_CI_HEAD:'a'.repeat(40),AIHR_CI_CONTROL_HEAD:'a'.repeat(40),TEST_DB_NAMESPACE:'plan_proto',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test_w_plan_proto1'};
 assertInstallEnvironment(e,'ai_hr_test_w_plan_proto1');
 for(const changes of [{GITHUB_ACTIONS:'false'},{GITHUB_EVENT_NAME:'push'},{GITHUB_RUN_ATTEMPT:'2'},{AIHR_CI_CONTROL_HEAD:'b'.repeat(40)},{TEST_DB_NAMESPACE:''},{TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test_w1'},{TEST_MIGRATION_DATABASE_URL:'postgres://postgres@staging.example.com:5433/ai_hr_test_w_plan_proto1'}])assert.throws(()=>assertInstallEnvironment({...e,...changes},'ai_hr_test_w_plan_proto1'));
});
