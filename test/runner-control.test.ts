import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {RUNNERS,runnerChangeSchema} from '../lib/runner-control-model';
import {isOperator} from '../lib/authz-model';
import type {SessionContext} from '../db/client';
describe('installation runner control',()=>{
 it('executes broker refusal, schedule, audit and in-flight transaction cases',()=>{
  const result=spawnSync('python3',['-I','-B','test/fixtures/runner-control-tests.py'],{encoding:'utf8'});
  expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.stderr).toMatch(/Ran 14 tests/);
 });
 it('rejects arbitrary runner, unit, target and schedule inputs',()=>{
  const valid={id:'reviews',revision:'a'.repeat(64),enabled:true,schedule:{time:'03:00'}};
  expect(runnerChangeSchema.safeParse(valid).success).toBe(true);
  for(const input of [{...valid,id:'../../x'},{...valid,unit:'attacker'},{...valid,environment:'production'},{...valid,schedule:{time:'03:00\nUser=root'}},{...valid,schedule:{minutes:0}}])expect(runnerChangeSchema.safeParse(input).success).toBe(false);
  // AI v2 P2-2a adds the Pre-salary loop's tick (payroll-loops).
  expect(new Set(RUNNERS.map(row=>row.id)).size).toBe(20);
 });
 it('does not infer host-control authority from customer or flattened roles',()=>{
  for(const grants of [[],[{role:'hr_admin',companyId:null}],[{role:'super_admin',companyId:null}]])expect(isOperator({roles:['operator'],grants} as SessionContext)).toBe(false);
  expect(isOperator({grants:[{role:'operator',companyId:null}]} as SessionContext)).toBe(true);
 });
});
