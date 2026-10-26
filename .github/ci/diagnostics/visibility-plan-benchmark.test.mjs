/** Pure counter/refusal data only; no database, Vitest, compiler or build. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVisibilityRows,benchmark} from './visibility-plan-benchmark.mjs';
const row=()=>({userid:'10',dbid:'200',queryid:'-33',toplevel:false,calls:20,plans:2,total_plan_time:3,total_exec_time:2,shared_blks_read:0,blk_read_time:0,jit_generation_time:0,jit_inlining_time:0,jit_optimization_time:0,jit_emission_time:0,query:'WITH RECURSIVE admin_company AS (...) caller_dept AS (...) SELECT 1'});
test('target statistics require complete distinct finite query records',()=>{
 assert.equal(validateVisibilityRows({count:1,rows:[row()]}).rows.length,1);
 for(const edit of [x=>x.count=2,x=>x.rows[0].plans=-1,x=>x.rows[0].plans=1.2,x=>x.rows[0].total_plan_time=Infinity,x=>x.rows[0].query='foreign query',x=>{x.count=2;x.rows.push(row());}]){const x={count:1,rows:[row()]};edit(x);assert.throws(()=>validateVisibilityRows(x));}
});
test('benchmark refuses non-owned invocation before source access or resource creation',async()=>{const previous=process.env.GITHUB_ACTIONS;try{process.env.GITHUB_ACTIONS='false';await assert.rejects(benchmark(),/Owned first-attempt/);}finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}});
