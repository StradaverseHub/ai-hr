import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { person,employment } from '../db/schema';
import { commitEmployeeImport } from '../core/import';
import { commitSectionImport } from '../core/import-sections';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const record=()=>({full_name:'Import Contract Person',email:'import-contract@fixture.test',department:'Finance',hired_on:todayInKualaLumpur(),employment_type:'full_time',employee_code:'CONTRACT01',basic_salary:'2500',first_name:'Import',correspondence_address_line_1:'Separate correspondence',personal_email:'personal-contract@fixture.test',gender:'female',date_of_birth:'1992-02-29'});
it('creates an optional-IC employee and preserves ordinary Profile fields through a blank section update',async()=>{
  const result=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[record()]});
  expect(result.failed).toEqual([]);expect(result.imported).toBe(1);
  const [before]=await owner.db.select().from(person).where(eq(person.primaryEmail,record().email));
  expect(before).toMatchObject({firstName:'Import',correspondenceAddressLine1:'Separate correspondence',personalEmail:'personal-contract@fixture.test',gender:'female',dateOfBirth:'1992-02-29'});
  const update=await commitSectionImport(adminCtx(b),{section:'profile',records:[{employee_code:'CONTRACT01',preferred_name:'New preferred',correspondence_address_line_1:'',personal_email:''}]});
  expect(update.failed).toEqual([]);expect(update.updated).toBe(1);
  const [after]=await owner.db.select().from(person).where(eq(person.id,before.id));
  expect(after).toMatchObject({preferredName:'New preferred',correspondenceAddressLine1:'Separate correspondence',personalEmail:'personal-contract@fixture.test'});
});
it('rolls back person, employment and statutory rows if the later compensation owner refuses',async()=>{
  await owner.db.execute(sql`CREATE FUNCTION public.personnel_import_test_refuse_comp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM employment WHERE id=NEW.employment_id AND employee_code='CONTRACT01') THEN RAISE EXCEPTION 'fixture compensation refusal'; END IF; RETURN NEW; END $$`);
  await owner.db.execute(sql`CREATE TRIGGER personnel_import_test_refuse_comp BEFORE INSERT ON compensation FOR EACH ROW EXECUTE FUNCTION public.personnel_import_test_refuse_comp()`);
  try {
    const result=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[record()]});
    expect(result.imported).toBe(0);expect(result.failed).toHaveLength(1);
    expect(await owner.db.select().from(person).where(eq(person.primaryEmail,record().email))).toEqual([]);
    expect(await owner.db.select().from(employment).where(eq(employment.employeeCode,'CONTRACT01'))).toEqual([]);
    // A failed row cannot leave statutory/compensation children with its missing employee identity.
    const leaked=await owner.db.execute(sql`select count(*)::integer as n from employee_statutory_my s join person p on p.id=s.person_id where p.primary_email=${record().email}`) as unknown as {n:number}[];
    expect(leaked[0].n).toBe(0);
  } finally {
    await owner.db.execute(sql`DROP TRIGGER personnel_import_test_refuse_comp ON compensation`);
    await owner.db.execute(sql`DROP FUNCTION public.personnel_import_test_refuse_comp()`);
  }
});
