import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {employeeDetail} from '../core/read';
import {commitSectionImport,validateSectionImport} from '../core/import-sections';
import {commitEmployeeImport,validateEmployeeImport} from '../core/import';
import {registerRecordsForEmployee} from '../core/personnel-register-import';
import {addQualification,archiveQualification,listQualifications,updateQualification} from '../core/qualifications';
import {addEmergencyContact,archiveEmergencyContact,listEmergencyContacts,updateEmergencyContact} from '../core/emergency-contacts';
import {assertProfileValueAllowed} from '../core/profile-options';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext;
const hire=(code:string)=>hireEmployee(ctx,{person:{fullName:code,primaryEmail:`${code.toLowerCase()}@register.test`},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
const fullRow=(code:string)=>({full_name:code,email:`${code.toLowerCase()}@register.test`,employee_code:code,department:'Finance',hired_on:'2026-01-01',employment_type:'full_time',ic_number:'900101105678',basic_salary:'5000'});
beforeAll(()=>migrateTestDb());beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});afterAll(()=>closeAll());

describe('Qualification and Emergency Contact register imports',()=>{
  it('creates repeated qualifications and applies an explicit-ID patch without clearing blank cells',async()=>{
    const e=await hire('REG001');
    const result=await commitSectionImport(ctx,{section:'qualification',records:[
      {employee_code:'REG001',record_id:'',qualification:'Bachelor',institute:'Institute A',from_ym:'2010-03',to_ym:'2014-08',graduation_date:'2014-09-01',is_highest:'true'},
      {employee_code:'REG001',record_id:'',qualification:'Diploma',institute:'Institute B',from_ym:'2008-02',to_ym:'2010-01',graduation_date:'2010-02-01',is_highest:'false'},
    ]});
    expect(result.fileErrors).toEqual([]);expect(result.updated).toBe(2);
    const rows=await listQualifications(ctx,{employmentId:e.employmentId});expect(rows).toHaveLength(2);
    const diploma=rows.find(row=>row.qualification==='Diploma')!;
    const preview=await validateSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',record_id:diploma.id,institute:'',from_ym:'',is_highest:'true',result:'Distinction'}]});
    expect(preview.rows[0]).toMatchObject({ok:true,registerAction:'update'});
    expect((await commitSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',record_id:diploma.id,institute:'',from_ym:'',is_highest:'true',result:'Distinction'}]})).updated).toBe(1);
    const fresh=await listQualifications(ctx,{employmentId:e.employmentId});
    expect(fresh.find(row=>row.id===diploma.id)).toMatchObject({institute:'Institute B',fromYm:'2008-02',result:'Distinction',isHighest:true});
    expect(fresh.filter(row=>row.isHighest)).toHaveLength(1);
    const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,diploma.id)).orderBy(sql`${schema.domainEvent.occurredAt} desc`).limit(1);
    expect(event.eventType).toBe('qualification.updated');expect(event.payload).toHaveProperty('clearedHighestId');
  });
  it('creates same-name contacts explicitly and preserves Primary transfer plus Profile compatibility',async()=>{
    const e=await hire('REG001');
    expect((await commitSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'Same Name',mobile_phone:'00123',priority:'primary'},{employee_code:'REG001',full_name:'Same Name',mobile_phone:'00456',priority:'secondary'}]})).updated).toBe(2);
    const contacts=await listEmergencyContacts(ctx,{personId:e.personId});expect(contacts).toHaveLength(2);
    const other=contacts.find(row=>row.priority==='secondary')!;
    expect((await commitSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',record_id:other.id,priority:'primary',mobile_phone:''}]})).updated).toBe(1);
    const fresh=await listEmergencyContacts(ctx,{personId:e.personId});expect(fresh[0]).toMatchObject({id:other.id,mobilePhone:'00456',priority:'primary'});
    const detail=await employeeDetail(ctx,e.employmentId);expect(detail?.emergencyContactPhone).toBe('00456');
    const exported=await registerRecordsForEmployee(ctx,'emergency','REG001');expect(exported.map(row=>row.record_id).sort()).toEqual(contacts.map(row=>row.id).sort());
    expect(exported.every(row=>row.employee_code==='REG001')).toBe(true);
  });
  it('refuses cross-employment qualification and cross-person contact IDs, including archived records',async()=>{
    const e=await hire('REG001'),other=await hire('REG002');
    const qualification=await addQualification(ctx,{employmentId:other.employmentId,qualification:'Bachelor'});
    const contact=await addEmergencyContact(ctx,{personId:other.personId,fullName:'Other'});
    for(const [section,id] of [['qualification',qualification.id],['emergency',contact.id]] as const) {
      const result=await commitSectionImport(ctx,{section,records:[{employee_code:'REG001',record_id:id,...section==='qualification'?{description:'Forged'}:{remarks:'Forged'}}]});
      expect(result.updated).toBe(0);expect(result.fileErrors.length).toBeGreaterThan(0);
    }
    await archiveQualification(ctx,qualification);await archiveEmergencyContact(ctx,contact);
    expect((await validateSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG002',record_id:qualification.id,institute:'Changed'}]})).rows[0].ok).toBe(false);
    expect((await validateSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG002',record_id:contact.id,full_name:'Changed'}]})).rows[0].ok).toBe(false);
    expect(await listQualifications(ctx,{employmentId:e.employmentId})).toEqual([]);
  });
  it('refuses duplicate IDs and multiple exclusive flags before any row is written',async()=>{
    const e=await hire('REG001');const q=await addQualification(ctx,{employmentId:e.employmentId,qualification:'Bachelor'});
    const duplicate=await validateSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',record_id:q.id,result:'A'},{employee_code:'REG001',record_id:q.id,result:'B'}]});
    expect(duplicate.rows.every(row=>!row.ok)).toBe(true);
    const flags=await commitSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',qualification:'Diploma',is_highest:'true'},{employee_code:'REG001',qualification:'Master',is_highest:'true'}]});
    expect(flags.updated).toBe(0);expect((await listQualifications(ctx,{employmentId:e.employmentId}))).toHaveLength(1);
    const contacts=await commitSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'One',priority:'primary'},{employee_code:'REG001',full_name:'Two',priority:'primary'}]});
    expect(contacts.updated).toBe(0);expect(await listEmergencyContacts(ctx,{personId:e.personId})).toEqual([]);
  });
  it('detects two Primary rows across different employment codes of the same person',async()=>{
    const e=await hire('REG001'),other=await hire('REG002');
    await owner.db.update(schema.employment).set({personId:e.personId}).where(eq(schema.employment.id,other.employmentId));
    const preview=await validateSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'One',priority:'primary'},{employee_code:'REG002',full_name:'Two',priority:'primary'}]});
    expect(preview.rows.every(row=>!row.ok)).toBe(true);expect(preview.fileErrors.length).toBeGreaterThan(0);
  });
  it('requires exact administered company scope, refuses employee/manager writers and inactive employment',async()=>{
    const e=await hire('REG001');
    for(const roles of [['employee'],['manager']]) {
      const actor={tenantId:b.tenantId,personId:e.personId,roles};
      const preview=await validateSectionImport(actor,{section:'emergency',records:[{employee_code:'REG001',full_name:'No rights'}]});expect(preview.updateCount).toBe(0);
      await expect(registerRecordsForEmployee(actor,'emergency','REG001')).rejects.toThrow('administered');
    }
    const [otherCompany]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other company',country:'MY'}).returning();
    const scoped={tenantId:b.tenantId,personId:e.personId,grants:[{role:'hr_admin',companyId:otherCompany.id},{role:'employee',companyId:b.companyId}]};
    expect((await commitSectionImport(scoped,{section:'qualification',records:[{employee_code:'REG001',qualification:'Bachelor'}]})).updated).toBe(0);
    await owner.db.update(schema.employment).set({terminatedOn:'2026-01-01'}).where(eq(schema.employment.id,e.employmentId));
    expect((await validateSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'No inactive writes'}]})).rows[0].ok).toBe(false);
  });
  it('refuses another tenant’s record ID even when the employee code matches',async()=>{
    const local=await hire('REG001');const foreign=await seedBase();
    const foreignCtx=adminCtx(foreign);const e=await hireEmployee(foreignCtx,{person:{fullName:'Foreign',primaryEmail:'foreign@register.test'},employeeCode:'REG001',companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
    const q=await addQualification(foreignCtx,{employmentId:e.employmentId,qualification:'Bachelor'});
    const preview=await validateSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',record_id:q.id,result:'No'}]});expect(preview.rows[0].ok).toBe(false);
    expect(await listQualifications(ctx,{employmentId:local.employmentId})).toEqual([]);
  });
  it('uses the canonical effective-date validator in preview and apply, without truncating months',async()=>{
    const e=await hire('REG001');const q=await addQualification(ctx,{employmentId:e.employmentId,qualification:'Bachelor',fromYm:'2020-01',toYm:'2020-12'});
    for(const record of [{from_ym:'2021-01'},{from_ym:'0000-01'},{from_ym:'2020-01-01'},{graduation_date:'2023-02-29'}]) {
      const records=[{employee_code:'REG001',record_id:q.id,...record}];
      expect((await validateSectionImport(ctx,{section:'qualification',records})).rows[0].ok).toBe(false);
      expect((await commitSectionImport(ctx,{section:'qualification',records})).updated).toBe(0);
    }
    await expect(updateQualification(ctx,{id:q.id,graduationDate:'2023-02-29'})).rejects.toThrow('real date');
  });
  it('never-configured catalogue accepts free text; all-inactive refuses new choices; unchanged legacy re-saves',async()=>{
    const e=await hire('REG001');
    await owner.db.delete(schema.profileOption).where(eq(schema.profileOption.tenantId,b.tenantId));
    const q=await addQualification(ctx,{employmentId:e.employmentId,qualification:'Legacy qualification'});
    const contact=await addEmergencyContact(ctx,{personId:e.personId,fullName:'Contact',relationship:'Legacy relationship'});
    await owner.db.insert(schema.profileOption).values([{tenantId:b.tenantId,category:'qualificationLevel',value:'Closed qualification',label:'Closed',isActive:false},{tenantId:b.tenantId,category:'relationship',value:'Closed relationship',label:'Closed',isActive:false}]);
    await withTenant(ctx,tx=>assertProfileValueAllowed(tx,'relationship','Legacy relationship','Legacy relationship'));
    await expect(withTenant(ctx,tx=>assertProfileValueAllowed(tx,'relationship','New relationship',null))).rejects.toThrow('not an active');
    await updateQualification(ctx,{id:q.id,qualification:'Legacy qualification',result:'Retained'});
    await updateEmergencyContact(ctx,{id:contact.id,relationship:'Legacy relationship',remarks:'Retained'});
    expect((await validateSectionImport(ctx,{section:'qualification',records:[{employee_code:'REG001',qualification:'New qualification'}]})).rows[0].ok).toBe(false);
    expect((await validateSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'New',relationship:'New relationship'}]})).rows[0].ok).toBe(false);
  });
  it('adds register rows through the full employee transaction and refuses orphan/explicit-existing-ID rows',async()=>{
    const records=[fullRow('REG001')];
    const registerRecords={qualification:[{employee_code:'REG001',qualification:'Bachelor',from_ym:'2010-03',to_ym:'2014-08',is_highest:'true'}],emergency:[{employee_code:'REG001',full_name:'Contact',priority:'primary',mobile_phone:'001234'}]};
    const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records,registerRecords});
    expect(result.fileErrors).toEqual([]);expect(result.imported).toBe(1);expect(result.registersImported).toEqual({qualification:1,emergency:1});
    const [employment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'REG001'));
    expect((await listQualifications(ctx,{employmentId:employment.id}))[0].fromYm).toBe('2010-03');
    const orphan=await validateEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('REG002')],registerRecords:{emergency:[{employee_code:'ABSENT',full_name:'Orphan'}]}});
    expect(orphan.fileErrors.length).toBeGreaterThan(0);expect(orphan.registers?.[0].rows[0].ok).toBe(false);
    const explicit=await validateEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('REG003')],registerRecords:{qualification:[{employee_code:'REG003',record_id:crypto.randomUUID(),qualification:'Bachelor'}]}});
    expect(explicit.fileErrors.length).toBeGreaterThan(0);
  });
  it('rolls back newly created employee, family and canonical events when a later register writer refuses',async()=>{
    // Real DB refusal after hire, statutory, compensation and Family owners have written in this Tx.
    await owner.sql.unsafe(`create function public.test_register_refusal() returns trigger language plpgsql as $$ begin raise exception 'test register refusal'; end $$`);
    await owner.sql.unsafe('create trigger test_register_refusal before insert on employee_qualification for each row execute function public.test_register_refusal()');
    try {
      const result=await commitEmployeeImport(ctx,{companyId:b.companyId,records:[fullRow('REG001')],dependentRecords:[{employee_code:'REG001',full_name:'Child',relationship:'child',date_of_birth:'2020-01-01'}],registerRecords:{qualification:[{employee_code:'REG001',qualification:'Bachelor'}]}});
      expect(result.imported).toBe(0);expect(result.dependentsImported).toBe(0);expect(result.registersImported).toEqual({qualification:0,emergency:0});expect(result.fileErrors.length).toBeGreaterThan(0);
      expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,'reg001@register.test'))).toEqual([]);
      expect(await owner.db.select().from(schema.employeeDependent)).toEqual([]);
      expect(await owner.db.select().from(schema.employeeQualification)).toEqual([]);
    }finally {await owner.sql.unsafe('drop trigger test_register_refusal on employee_qualification');await owner.sql.unsafe('drop function public.test_register_refusal()');}
  });
  it('refuses over-limit rows before consulting the database and refuses unknown register columns',async()=>{
    await expect(validateSectionImport(ctx,{section:'qualification',records:Array.from({length:501},()=>({employee_code:'REG001',qualification:'Bachelor'}))})).rejects.toThrow('500');
    await hire('REG001');const result=await commitSectionImport(ctx,{section:'emergency',records:[{employee_code:'REG001',full_name:'Contact',unknown_table:'Ignored?'}]});expect(result.updated).toBe(0);expect(result.fileErrors.length).toBeGreaterThan(0);
  });
});
