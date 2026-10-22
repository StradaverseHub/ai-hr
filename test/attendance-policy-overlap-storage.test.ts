/** Prepared DB operator smoke tests use the ACTUAL installed exclusion definitions in a disposable
 * temp instrument. They do not establish the real settlement trigger/authorization/rounding journey. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
describe('installed policy reservation exclusion definitions',()=>{
 it('excludes policy/policy and policy/unknown legacy across companies and modes, preserves adjacency and legacy pairs',async()=>{
  await owner.client.begin(async tx=>{
   const rows=await tx<{conname:string;definition:string}[]>`select conname,pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid='public.overtime_source_settlement'::regclass
     and conname in('overtime_policy_physical_no_overlap','overtime_policy_legacy_possible_overlap') order by conname`;
   expect(rows).toHaveLength(2);
   await tx`create temporary table board1_coverage_probe(tenant_id uuid,coverage_employment_id uuid,coverage_kind text,
    reservation_coverage int8multirange,released_at timestamptz,company_id uuid,mode text) on commit drop`;
   for(const [index,row]of rows.entries())await tx.unsafe('alter table board1_coverage_probe add constraint coverage_probe_'+index+' '+row.definition);
   const tenant=randomUUID(),employee=randomUUID(),first=randomUUID(),second=randomUUID();
   await tx`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'policyPhysical','{[100,200)}',null,${first}::uuid,'cash')`;
   await expect(tx.savepoint(sp=>sp`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'policyPhysical','{[150,250)}',null,${second}::uuid,'toil')`)).rejects.toMatchObject({code:'23P01'});
   await expect(tx.savepoint(sp=>sp`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'legacyUnknown','{[150,250)}',null,${second}::uuid,'cash')`)).rejects.toMatchObject({code:'23P01'});
   await tx`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'policyPhysical','{[200,250)}',null,${second}::uuid,'toil')`;
   await tx`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'legacyUnknown','{[300,400)}',null,${first}::uuid,'cash')`;
   await tx`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'legacyUnknown','{[350,450)}',null,${second}::uuid,'toil')`;
   await tx`update board1_coverage_probe set released_at=clock_timestamp() where coverage_kind='policyPhysical'`;
   await tx`insert into board1_coverage_probe values(${tenant}::uuid,${employee}::uuid,'policyPhysical','{[100,200)}',null,${second}::uuid,'toil')`;
  });
 });
 it('retains no directly executable coverage-mint capability for the application role',async()=>{
  const [row]=await owner.client<{allowed:boolean}[]>`select has_function_privilege('ai_hr_app','app.capture_overtime_settlement_coverage()','EXECUTE') as allowed`;
  expect(row.allowed).toBe(false);
  const triggers=await owner.client<{tgname:string}[]>`select tgname from pg_trigger where tgrelid='public.overtime_source_settlement'::regclass
   and tgname in('aa_attendance_policy_settlement_stage','ab_overtime_settlement_coverage') and not tgisinternal order by tgname`;
  expect(triggers.map(trigger=>trigger.tgname)).toEqual(['aa_attendance_policy_settlement_stage','ab_overtime_settlement_coverage']);
  const columns=await owner.client<{attname:string}[]>`select attname from pg_attribute where attrelid='public.overtime_source_settlement'::regclass
   and attname in('coverage_employment_id','coverage_calculation_id','coverage_kind','reservation_coverage') and not attisdropped order by attname`;
  expect(columns.map(row=>row.attname)).toEqual(['coverage_calculation_id','coverage_employment_id','coverage_kind','reservation_coverage']);
 });
});
