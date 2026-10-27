import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {approvedEmailOrdering,migrationProblems,reviewedMigrationProblems} from './check-migration-order.mjs';
const base='d8b2bac9705fd8fbc4d3eb500262b19858bf297d';
const prior=path=>execFileSync('git',['show',base+':'+path]);
const before=JSON.parse(prior('db/migrations/meta/_journal.json')).entries;
const after=JSON.parse(readFileSync('db/migrations/meta/_journal.json')).entries;
const previous=tag=>prior('db/migrations/'+tag+'.sql'),current=tag=>readFileSync('db/migrations/'+tag+'.sql');
test('exact approved transition passes while original general guard remains strict',()=>{
 assert.equal(approvedEmailOrdering(before,after,previous,current),true);
 assert.deepEqual(reviewedMigrationProblems(before,after,previous,current),{approvedEmailOrdering:true,problems:[]});
 assert(migrationProblems(before,after,previous,current).length>0);
});
test('changes to any applied entry, pending timestamp or metadata refuse the exception',()=>{
 for(const [index,key,value] of [[0,'when',1],[503,'idx',620],[504,'idx',620],[504,'when',1793110000001],[504,'tag','0640_other'],[503,'breakpoints',false]]){
  const rows=structuredClone(after);rows[index][key]=value;
  assert.equal(approvedEmailOrdering(before,rows,previous,current),false);
  assert(reviewedMigrationProblems(before,rows,previous,current).problems.length>0);
 }
});
test('changed old base, SQL, truncation, duplicate or extra migration cannot use approval',()=>{
 const old=structuredClone(before);old[0].idx=42;assert.equal(approvedEmailOrdering(old,after,previous,current),false);
 for(const tag of ['0640_onehr_plan_reviewer_scope','0641_account_email_delivery_history']){
  const changed=key=>key===tag?Buffer.from('select 1;'):current(key);
  assert.equal(approvedEmailOrdering(before,after,previous,changed),false);
 }
 assert.equal(approvedEmailOrdering(before,after,()=>Buffer.from('changed'),current),false);
 for(const rows of [after.slice(1),after.slice(0,504),[...after,after[504]]])assert.equal(approvedEmailOrdering(before,rows,previous,current),false);
});
test('earlier applied SQL edits still fail even for the approved metadata transition',()=>{
 const tag=before[0].tag,changed=key=>key===tag?Buffer.from('changed applied SQL'):current(key);
 const result=reviewedMigrationProblems(before,after,previous,changed);
 assert.equal(result.approvedEmailOrdering,true);assert(result.problems.includes('Applied SQL changed: '+tag));
});
