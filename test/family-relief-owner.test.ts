/** Must execute under all leases after the reserved migrations are journalled. */
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,owner} from './harness';
import {childReliefEligible,type ChildReliefRow,CHILD_RELIEF_CATEGORIES} from '../lib/dependent-vocabulary';
import {familyChildReliefSql,familyGridCompleteSql} from '../localization/my/family-relief-sql';
import {familyGridComplete} from '../lib/family-child-relief-rule';
const migration=readFileSync(new URL('../db/migrations/0579_configurable_access.sql',import.meta.url),'utf8');
const asOf='2026-06-15';
const base:ChildReliefRow={relationship:'child',dateOfBirth:'2009-06-15',isStudent:false,isDeceased:false,archivedAt:null,childTaxRelief:null,childReliefCategory:null};
const cases:[string,Partial<ChildReliefRow>,boolean][]=[
 ['under eighteen inferred',{},true],['eighteenth birthday',{dateOfBirth:'2008-06-15'},false],
 ['day before eighteenth birthday',{dateOfBirth:'2008-06-16'},true],['future DOB remains clamped',{dateOfBirth:'2027-01-01'},true],
 ['explicit refusal stays final',{childTaxRelief:false,isStudent:true},false],
 ['consent alone cannot justify older child',{dateOfBirth:'2000-01-01',childTaxRelief:true,childReliefCategory:'under_18'},false],
 ['older studying with consent',{dateOfBirth:'2000-01-01',childTaxRelief:true,isStudent:true},true],
 ['older student inference retained',{dateOfBirth:'2000-01-01',childTaxRelief:null,isStudent:true},true],
 ['category does not imply consent',{dateOfBirth:'2000-01-01',childTaxRelief:null,childReliefCategory:'disabled'},false],
 ['no DOB cannot infer age',{dateOfBirth:null},false],['explicit supported category without DOB',{dateOfBirth:null,childTaxRelief:true,childReliefCategory:'disabled'},true],
 ['deceased excluded',{isDeceased:true,childTaxRelief:true},false],['archived excluded',{archivedAt:new Date('2026-01-01')},false],
 ['other relationship excluded',{relationship:'parent'},false],
 ...['study_preu','study_tertiary','disabled','disabled_study'].map(category=>['older category '+category,{dateOfBirth:'2000-01-01',childTaxRelief:true,childReliefCategory:category},true] as [string,Partial<ChildReliefRow>,boolean]),
];
beforeAll(migrateTestDb);afterAll(closeAll);
describe('one Family eligibility decision graph, two execution backends',()=>{
 it('installs the exact expression produced by the canonical declaration',()=>{
  const body=migration.split('CREATE FUNCTION app.my_family_child_relief_eligible(')[1].split('$$;')[0].split('AS $$')[1].trim();
  expect(body.replace(/\s+/g,'')).toBe(('SELECT '+familyChildReliefSql()+';').replace(/\s+/g,''));
  const categories=CHILD_RELIEF_CATEGORIES.map(value=>"'"+value+"'").join(',');
  expect(migration).toContain('d.child_relief_category IN ('+categories+')');
  const gridBody=migration.split('CREATE FUNCTION app.my_family_grid_complete(')[1].split('$$;')[0].split('AS $$')[1].trim();
  expect(gridBody.replace(/\s+/g,'')).toBe(('SELECT '+familyGridCompleteSql()+';').replace(/\s+/g,''));
 });
 it.each([[0,0,false],[1,1,true],[2,1,false],[1,2,false],[2,2,true]] as const)('shares the complete positive grid rule for %i/%i',async(eligible,categorised,expected)=>{
  expect(familyGridComplete(eligible,categorised)).toBe(expected);
  const [result]=await owner.db.execute<{complete:boolean}>(sql`select app.my_family_grid_complete(${eligible}::integer,${categorised}::integer) as complete`);
  expect(result.complete).toBe(expected);
 });
 it.each(cases)('%s matches the independent retained policy expectation in JS and PostgreSQL',async(_name,patch,expected)=>{
  const row={...base,...patch};expect(childReliefEligible(row,new Date(asOf+'T00:00:00Z'))).toBe(expected);
  const value={relationship:row.relationship,date_of_birth:row.dateOfBirth,is_student:row.isStudent,is_deceased:row.isDeceased,
   archived_at:row.archivedAt,child_tax_relief:row.childTaxRelief,child_relief_category:row.childReliefCategory};
  const [result]=await owner.db.execute<{eligible:boolean}>(sql`select app.my_family_child_relief_eligible(jsonb_populate_record(null::public.employee_dependent,${JSON.stringify(value)}::jsonb),${asOf}::date) as eligible`);
  expect(result.eligible).toBe(expected);
 });
 it.each([['2026-02-28',true],['2026-03-01',false]] as const)('keeps a leap-day eighteenth birthday correct on %s',async(date,expected)=>{
  const row={...base,dateOfBirth:'2008-02-29'};expect(childReliefEligible(row,new Date(date+'T00:00:00Z'))).toBe(expected);
  const [result]=await owner.db.execute<{eligible:boolean}>(sql`select app.my_family_child_relief_eligible(jsonb_populate_record(null::public.employee_dependent,'{"relationship":"child","date_of_birth":"2008-02-29"}'::jsonb),${date}::date) as eligible`);
  expect(result.eligible).toBe(expected);
 });
});
