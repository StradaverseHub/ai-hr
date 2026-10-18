import * as tenantClient from '../db/client';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { person,employment,employeeStatutoryMy,employeeDependent } from '../db/schema';
import { commitEmployeeImport } from '../core/import';
import { commitSectionImport } from '../core/import-sections';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const record=()=>({full_name:'Import Contract Person',email:'import-contract@fixture.test',department:'Finance',hired_on:todayInKualaLumpur(),employment_type:'full_time',employee_code:'CONTRACT01',basic_salary:'2500',bank_name:'Maybank',bank_account_no:'001234567',epf_number:'00987654',socso_number:'00112233',first_name:'Import',correspondence_address_line_1:'Separate correspondence',personal_email:'personal-contract@fixture.test',gender:'female',date_of_birth:'1992-02-29'});
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

it('updates registration numbers through a partial owner without clearing statutory or bank settings',async()=>{
  const created=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[record()]});expect(created.failed).toEqual([]);
  const [subject]=await owner.db.select().from(person).where(eq(person.primaryEmail,record().email));
  const [before]=await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,subject.id));
  const updated=await commitSectionImport(adminCtx(b),{section:'bank_statutory',records:[{employee_code:'CONTRACT01',epf_number:'0000999',socso_number:''}]});
  expect(updated.failed).toEqual([]);expect(updated.updated).toBe(1);
  const [after]=await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,subject.id));
  expect(after.epfNumber).toBe('0000999');expect(after.socsoNumber).toBe('00112233');
  const {epfNumber:oldEpf,updatedAt:oldUpdated,...unchangedBefore}=before;
  const {epfNumber:newEpf,updatedAt:newUpdated,...unchangedAfter}=after;
  expect(unchangedAfter).toEqual(unchangedBefore);
});

it('preserves a concurrent Profile edit when the imported columns leave core identity blank',async()=>{
 await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[record()]});
 const [subject]=await owner.db.select().from(person).where(eq(person.primaryEmail,record().email));
 const original=tenantClient.withTenant;let injected=false;
 const intercept:typeof original=async<T>(ctx:tenantClient.SessionContext,fn:(tx:tenantClient.Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>{
   const result=await original(ctx,fn,options);
   if(!injected) {injected=true;await owner.db.update(person).set({phone:'NEW-PHONE',primaryEmail:'new-identity@fixture.test'}).where(eq(person.id,subject.id));}
   return result;
 };
 const spy=vi.spyOn(tenantClient,'withTenant').mockImplementation(intercept);
 try {
  const result=await commitSectionImport(adminCtx(b),{section:'profile',records:[{employee_code:'CONTRACT01',preferred_name:'Imported preferred',phone:'',email:''}]});
  expect(result.failed).toEqual([]);expect(result.updated).toBe(1);
  const [saved]=await owner.db.select().from(person).where(eq(person.id,subject.id));
  expect(saved).toMatchObject({preferredName:'Imported preferred',phone:'NEW-PHONE',primaryEmail:'new-identity@fixture.test'});
 } finally {spy.mockRestore();}
});
it('saves old-card and passport supplementary columns through the Profile owner',async()=>{
 await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[{...record(),nationality:'Malaysia',passport_number:'FICTIONAL-P',passport_issue_date:'2020-01-01',passport_expiry_date:'2030-01-01',passport_issuing_country_code:'MY',passport_remark:'Original passport note'}]});
 const [subject]=await owner.db.select().from(person).where(eq(person.primaryEmail,record().email));
 const result=await commitSectionImport(adminCtx(b),{section:'profile',records:[{employee_code:'CONTRACT01',old_ic_number:'OLD-FICTIONAL',passport_issuing_country_code:'SG',passport_remark:'Corrected passport note'}]});
 expect(result.failed).toEqual([]);expect(result.updated).toBe(1);
 const [saved]=await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,subject.id));
 expect(saved).toMatchObject({oldIcNumber:'OLD-FICTIONAL',passportNumber:'FICTIONAL-P',passportIssueDate:'2020-01-01',passportExpiryDate:'2030-01-01',passportIssuingCountryCode:'SG',passportRemark:'Corrected passport note'});
});
it('imports and re-uploads distinct same-name children without collapsing their identities',async()=>{
 await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[record()]});
 const records=[{employee_code:'CONTRACT01',full_name:'Fictional Same Child',relationship:'child',date_of_birth:'2015-01-01',ic_or_passport:'CHILD-A'}, {employee_code:'CONTRACT01',full_name:'Fictional Same Child',relationship:'child',date_of_birth:'2015-01-01',ic_or_passport:'CHILD-B'}];
 const first=await commitSectionImport(adminCtx(b),{section:'family',records});expect(first.failed).toEqual([]);expect(first.updated).toBe(2);
 const second=await commitSectionImport(adminCtx(b),{section:'family',records});expect(second.failed).toEqual([]);expect(second.updated).toBe(0);expect(second.skipped).toBe(2);
 const [subject]=await owner.db.select().from(person).where(eq(person.primaryEmail,record().email));
 const saved=await owner.db.select().from(employeeDependent).where(eq(employeeDependent.personId,subject.id));
 expect(saved.map(row=>row.icOrPassport).sort()).toEqual(['CHILD-A','CHILD-B']);
});

it('persists Attendance and payment choices through their canonical owners and preserves blank updates',async()=>{
 const created=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[{...record(),card_id:'00007',attendance_photo_setting:'optional',payment_method:'bank_transfer'}]});
 expect(created.failed).toEqual([]);expect(created.imported).toBe(1);
 const [before]=await owner.db.select().from(employment).where(eq(employment.employeeCode,'CONTRACT01'));
 expect(before).toMatchObject({cardId:'00007',attendancePhotoSetting:'optional',paymentMethod:'bank_transfer'});
 const updated=await commitSectionImport(adminCtx(b),{section:'profile',records:[{employee_code:'CONTRACT01',attendance_photo_setting:'required',card_id:''}]});
 expect(updated.failed).toEqual([]);expect(updated.updated).toBe(1);
 const [after]=await owner.db.select().from(employment).where(eq(employment.id,before.id));
 expect(after).toMatchObject({cardId:'00007',attendancePhotoSetting:'required',paymentMethod:'bank_transfer'});
});
it('refuses missing Bank Transfer destination and a card colliding with another file employee code',async()=>{
 const missing=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[{...record(),bank_name:'',bank_account_no:'',payment_method:'bank_transfer'}]});
 expect(missing.imported).toBe(0);
 const card=await commitEmployeeImport(adminCtx(b),{companyId:b.companyId,records:[{...record(),card_id:'OTHER01'},{...record(),employee_code:'OTHER01',email:'other-contract@fixture.test',card_id:''}]});
 expect(card.imported).toBe(1);expect(card.skipped).toBe(1);
 expect(await owner.db.select().from(employment).where(eq(employment.employeeCode,'CONTRACT01'))).toEqual([]);
});
