/** Prepared Workforce consumer/RLS regressions; requires verified Board1 principal owner and all leases. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {db,withTenant,type SessionContext} from '../db/client';
import {person,employment,employeeDraft,roleAssignment,appUser,jobGrade,domainEvent,employeeDependent,employeeQualification,personEmergencyContact,employeeDocument,compensation} from '../db/schema';
import {hireEmployee,setEmployeeCode,updatePerson,setEmploymentGrade} from '../core/org';
import {hireEmployee as hireWorkforceEmployee,setEmploymentInfo as maintainInfo,setPersonComplianceFields as maintainCompliance} from '../core/workforce-commands';
import {createMovementEvent} from '../core/movement';
import {sweepDueMovements} from '../core/movement-apply';
import {previewMovementImport,commitMovementImport,movementImportCatalog,movementImportDownloadData} from '../core/movement-import';
import {validateEmployeeImport,commitEmployeeImport} from '../core/import';
import {toCsv} from '../lib/csv';
import {setCompensation} from '../core/comp';
import {setEmploymentTestRecord} from '../core/employment-test-record';
import {setPersonPhoto} from '../core/person-photo';
import {listEmployees,listWorkforcePickOptions,listEmployeesPage,countEmployeesByStatus,employeeDetail,type EmployeeListFilters} from '../core/read';
import {workforceRecord} from '../core/workforce-record';
import {WORKFORCE_PROFILE_FIELDS} from '../lib/workforce-record-fields';
import {workforceCompanies,workforceViewScope,workforceCommandAccess,WorkforceAccessError} from '../core/workforce-access';
import {WorkforceRecordChangedError} from '../core/workforce-code';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import * as registers from '../core/workforce-registers';
import {archiveDependent as archiveDependentOwner} from '../core/dependents';
import {archiveQualification as archiveQualificationOwner} from '../core/qualifications';
import {addEmployeeDocument,getEmployeeDocument,listEmployeeDocuments,updateEmployeeDocumentMeta,replaceEmployeeDocumentContent,deleteEmployeeDocument} from '../core/employee-documents';
const routeSession=vi.hoisted(()=>({ctx:null as SessionContext|null}));
vi.mock('../lib/session',()=>({getSession:async()=>{if(!routeSession.ctx)throw new Error('No fixture identity');return routeSession.ctx;}}));
import {GET as downloadDocument} from '../app/admin/personnel/[employmentId]/document/[docId]/route';

let b:Base;
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);});
afterAll(async()=>{try{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);}finally{await closeAll();}});
async function activate(){await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);}
async function override(userId:string,capabilityId:'workforce.view'|'workforce.maintain',companyId:string|null,effect:'allow'|'deny'|null){
 const before=await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId,capabilityId,companyId,effect}};
 const preview=await previewAccessConfiguration(admin(),edit,accessConfigurationStore);return saveAccessConfiguration(admin(),{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
const hire=(label:string)=>hireEmployee(admin(),{person:{fullName:label,primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
const page=(ctx:SessionContext,companyIds=[b.companyId])=>listEmployeesPage(ctx,{companyIds,limit:25,offset:0},'workforce');
async function sqlRefusal(work:Promise<unknown>,state='42501'){
 const error=await work.then(()=>null,error=>error);
 expect(error).not.toBeNull();expect(pgSqlState(error)).toBe(state);
}
describe('fresh Workforce-purpose record consumers',()=>{
 it('keeps dormant/default HR list, count and detail identical to the existing projection',async()=>{
  const subject=await hire('Fictional default record');
  expect(await page(admin())).toEqual(await listEmployeesPage(admin(),{companyIds:[b.companyId],limit:25,offset:0}));
  expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toEqual(await employeeDetail(admin(),subject.employmentId));
  expect(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]},'workforce')).toEqual(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]}));
 });
 it('uses the same filters, status ladder, paging and column values through the bounded projection',async()=>{
  const a=await hire('Fictional Alpha'),z=await hire('Fictional Zulu');
  await owner.db.update(employment).set({employeeCode:'WF-ALPHA',finalConfirmationDate:todayInKualaLumpur()}).where(eq(employment.id,a.employmentId));
  await owner.db.update(employment).set({employeeCode:'WF-ZULU',blacklistedAt:todayInKualaLumpur()}).where(eq(employment.id,z.employmentId));
  const filters:EmployeeListFilters[]=[{}, {q:'wf-alpha'}, {q:'fictional zulu'}, {departmentId:b.deptA},
   {departmentIds:[b.deptB]}, {companyId:b.companyId}, {filterCompanyIds:[b.companyId]},
   {employmentType:'full_time'}, {employmentType:'contract'}, {status:'active'}, {status:'terminated'},
   {employmentStatuses:['blacklisted']}, {employmentStatuses:['active','probation']}];
  for(const filter of filters){
   const scope={companyIds:[b.companyId],...filter};
   for(const offset of [0,1]){
    const params={...scope,limit:1,offset,sort:'company' as const};
    expect(await listEmployeesPage(admin(),params,'workforce')).toEqual(await listEmployeesPage(admin(),params));
   }
   expect(await countEmployeesByStatus(admin(),scope,'workforce')).toEqual(await countEmployeesByStatus(admin(),scope));
  }
  const keys=['employmentId','name','email','employeeCode','department','departmentId','position','company','companyId',
   'hiredOn','terminatedOn','confirmationDate','finalConfirmationDate','probationEndDate','provisionalEndOn',
   'resignationDate','lastWorkingDate','blacklistedAt','jobGrade','employmentType','businessUnit','costCenter','workLocation','joinDate','reportingTo'].sort();
  const rows=await withTenant(admin(),tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.access_workforce_list_rows() as r(value)`));
  expect(rows).toHaveLength(2);
  for(const {value}of rows)expect(Object.keys(value).sort()).toEqual(keys);
  // Screen pickers receive fewer identifiers than the independent payroll/attendance picker.
  const picker=await listWorkforcePickOptions(admin(),[b.companyId]);
  expect(picker.map(row=>row.employmentId).sort()).toEqual([a.employmentId,z.employmentId].sort());
  for(const row of picker)expect(Object.keys(row).sort()).toEqual(['employmentId','name','employeeCode','companyId','company','department','terminatedOn'].sort());
 });
 it('applies a new read denial to the row, count, switcher and detail in the same signed-in context',async()=>{
  const subject=await hire('Fictional denied record');await activate();expect((await page(admin())).total).toBe(1);
  await override(b.adminUserId,'workforce.view',b.companyId,'deny');
  expect(await page(admin())).toEqual({rows:[],total:0});
  expect(await countEmployeesByStatus(admin(),{companyIds:[b.companyId]},'workforce')).toEqual({total:0,byStatus:{}});
  expect(await listWorkforcePickOptions(admin(), [b.companyId])).toEqual([]);expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toBeNull();
  expect(await workforceCompanies(admin())).not.toContain(b.companyId);
  expect(await withTenant(admin(),tx=>tx.execute(sql`select * from app.access_workforce_list_rows()`))).toEqual([]);
  // Staff-directory relationship access remains independent; no financial grant or role is added.
  expect((await listEmployees(admin(),[b.companyId])).map(row=>row.employmentId)).toContain(subject.employmentId);
  await override(b.adminUserId,'workforce.view',b.companyId,null);expect((await page(admin())).total).toBe(1);
 });
 it('does not widen an explicitly empty selected Workforce company scope',async()=>{
  await hire('Fictional retained record');await activate();
  expect(await page(admin(),[])).toEqual({rows:[],total:0});expect(await listWorkforcePickOptions(admin(), [])).toEqual([]);
  expect(await countEmployeesByStatus(admin(),{companyIds:[]},'workforce')).toEqual({total:0,byStatus:{}});
 });
 it('refuses profile and code changes without modifying the master or emitting their events',async()=>{
  const subject=await hire('Fictional immutable denied record');await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(person).where(eq(person.id,subject.personId));
  const codes=await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,subject.employmentId));
  const events=await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id);
  await expect(updatePerson(admin(),{personId:subject.personId,fullName:'Not applied',primaryEmail:'not-applied@example.invalid',via:'employee-profile'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'NOT-APPLIED'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(maintainCompliance(admin(),{employmentId:subject.employmentId,gender:'male'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(setEmploymentTestRecord(admin(),{employmentId:subject.employmentId,isTestRecord:true})).rejects.toBeInstanceOf(WorkforceAccessError);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1]);
  await expect(setPersonPhoto(admin(),{personId:subject.personId,content:bytes,fileName:'not-applied.png',mimeType:'image/png',sizeBytes:bytes.length})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await owner.db.select().from(person).where(eq(person.id,subject.personId))).toEqual(before);
  expect(await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,subject.employmentId))).toEqual(codes);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)).toEqual(events);
 });
 it('blocks Workforce hire, employment-info and direct Movement entry without disabling a separate grade owner',async()=>{
  const subject=await hire('Fictional guarded master');await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(employment).where(eq(employment.tenantId,b.tenantId)).orderBy(employment.id);
  await expect(hireWorkforceEmployee(admin(),{person:{fullName:'Never hired',primaryEmail:'not-hired@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(hireEmployee(admin(),{person:{fullName:'No direct-owner bypass',primaryEmail:'not-hired-direct@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(maintainInfo(admin(),{employmentId:subject.employmentId,orgDivision:'Not applied'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(createMovementEvent(admin(),{employmentId:subject.employmentId,kind:'increment',effectiveDate:todayInKualaLumpur(),basicSalary:3025.13,remarks:'Fictional guarded movement'})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await owner.db.select().from(employment).where(eq(employment.tenantId,b.tenantId)).orderBy(employment.id)).toEqual(before);
  // A verified Rewards posting consumes the unchanged canonical grade owner, not a fabricated
  // Workforce permission. Its own role/stage/revision checks remain required at that consumer.
  const [grade]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'WF-INDEPENDENT',name:'Fictional independently approved grade'}).returning({id:jobGrade.id});
  await expect(setEmploymentGrade(admin(),{employmentId:subject.employmentId,gradeId:grade.id})).resolves.toMatchObject({changed:true});
  expect((await owner.db.select({gradeId:employment.gradeId}).from(employment).where(eq(employment.id,subject.employmentId)))[0]?.gradeId).toBe(grade.id);
 });
 it('enforces identifier and test-classification updates in SQL without borrowing a definer owner',async()=>{
  const subject=await hire('Fictional SQL master boundary');
  // Dormant defaults preserve the canonical HR commands and their actual audit events.
  await setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'WF-SQL-BASE'});
  expect(await setEmploymentTestRecord(admin(),{employmentId:subject.employmentId,isTestRecord:true})).toEqual({changed:true});
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const read=()=>owner.db.select().from(employment).where(eq(employment.id,subject.employmentId));
  const before=await read(),events=await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id);
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employment).set({employeeCode:'WF-RAW-FORBIDDEN'}).where(eq(employment.id,subject.employmentId))));
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employment).set({isTestRecord:false}).where(eq(employment.id,subject.employmentId))));
  // A deliberately callable definer demonstrates that its current_user cannot lend owner status
  // to the restricted connection. Only this fictional test database receives the probe function.
  await owner.db.execute(sql.raw("CREATE FUNCTION app.test_workforce_definer_update(subject uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ UPDATE public.employment SET employee_code='WF-DEFINER-FORBIDDEN' WHERE id=subject $$"));
  try{
   await owner.db.execute(sql.raw('REVOKE ALL ON FUNCTION app.test_workforce_definer_update(uuid) FROM PUBLIC'));
   await owner.db.execute(sql.raw('GRANT EXECUTE ON FUNCTION app.test_workforce_definer_update(uuid) TO ai_hr_app'));
   await sqlRefusal(withTenant(admin(),tx=>tx.execute(sql`select app.test_workforce_definer_update(${subject.employmentId}::uuid)`)));
  }finally{await owner.db.execute(sql.raw('DROP FUNCTION app.test_workforce_definer_update(uuid)'));}
  // Naming a protected column without changing its value is not a new master edit.
  await withTenant(admin(),tx=>tx.update(employment).set({employeeCode:'WF-SQL-BASE',isTestRecord:true}).where(eq(employment.id,subject.employmentId)));
  expect(await read()).toEqual(before);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)).toEqual(events);
  await expect(withTenant(admin(),tx=>tx.execute(sql`select app.access_workforce_storage_owner()`))).rejects.toThrow();
  // Real owner credentials remain an explicit maintenance/restore course, with no invented login.
  await owner.db.update(employment).set({employeeCode:'WF-OWNER-REPAIR'}).where(eq(employment.id,subject.employmentId));
  expect((await read())[0]?.employeeCode).toBe('WF-OWNER-REPAIR');
  await override(b.adminUserId,'workforce.maintain',b.companyId,null);
  await setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'WF-SQL-RESTORED'});
  expect(await setEmploymentTestRecord(admin(),{employmentId:subject.employmentId,isTestRecord:false})).toEqual({changed:true});
  expect((await read())[0]).toMatchObject({employeeCode:'WF-SQL-RESTORED',isTestRecord:false});
 });
 it('refuses a raw hire after denial and rolls back its new person in the same transaction',async()=>{
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const personId=randomUUID(),employmentId=randomUUID();
  const before=await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id);
  await sqlRefusal(withTenant(admin(),async tx=>{
   await tx.insert(person).values({id:personId,tenantId:b.tenantId,fullName:'Fictional never committed',primaryEmail:'wf-raw-hire@example.invalid'});
   await tx.insert(employment).values({id:employmentId,tenantId:b.tenantId,personId,companyId:b.companyId,hiredOn:todayInKualaLumpur(),employeeCode:'WF-RAW-HIRE',isTestRecord:true});
  }));
  expect(await owner.db.select({id:person.id}).from(person).where(eq(person.id,personId))).toEqual([]);
  expect(await owner.db.select({id:employment.id}).from(employment).where(eq(employment.id,employmentId))).toEqual([]);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)).toEqual(before);
 });
 it.each(['command','raw-document','raw-draft'] as const)('refuses %s maintenance from a pinned old snapshot after a completed permission revocation',async operation=>{
  const subject=await hire('Fictional stale snapshot subject');await activate();
  const document=await addEmployeeDocument(admin(),{employmentId:subject.employmentId,title:'Fictional retained snapshot file',fileName:'fictional.txt',mimeType:'text/plain',content:Buffer.from('Fictional evidence')});
  const before=await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId));
  const documents=await owner.db.select().from(employeeDocument).where(eq(employeeDocument.id,document.id));
  const [draft]=await owner.db.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,label:'Fictional retained snapshot draft',data:{}}).returning({id:employeeDraft.id});
  const drafts=await owner.db.select().from(employeeDraft).where(eq(employeeDraft.id,draft.id));
  let signalPinned!:()=>void,resume!:()=>void,pinnedReached=false;
  const pinned=new Promise<void>(resolve=>{signalPinned=resolve;}),changed=new Promise<void>(resolve=>{resume=resolve;});
  // A deliberate raw runtime transaction tests SQL isolation, rather than changing withTenant's
  // ordinary READ COMMITTED owner or pretending a mocked lock demonstrates concurrency.
  const outcome=db.transaction(async tx=>{
   const ctx=admin();
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(ctx.grants)},true)`);
   await tx.select({id:employment.id}).from(employment).where(eq(employment.id,subject.employmentId));
   pinnedReached=true;signalPinned();await changed;
   if(operation==='command')await maintainInfo(ctx,{employmentId:subject.employmentId,orgDivision:'Must not use old authority'},tx);
   else if(operation==='raw-document')await tx.update(employeeDocument).set({title:'Must not use old authority'}).where(eq(employeeDocument.id,document.id));
   else await tx.update(employeeDraft).set({label:'Must not use old authority'}).where(eq(employeeDraft.id,draft.id));
  },{isolationLevel:'repeatable read'}).then(()=>null,error=>{signalPinned();return error;});
  await pinned;
  try{expect(pinnedReached).toBe(true);await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');}
  finally{resume();}
  expect(pgSqlState(await outcome)).toBe('40001');
  expect(await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId))).toEqual(before);
  expect(await owner.db.select().from(employeeDocument).where(eq(employeeDocument.id,document.id))).toEqual(documents);
  expect(await owner.db.select().from(employeeDraft).where(eq(employeeDraft.id,draft.id))).toEqual(drafts);
 });
 it('rechecks permission before returning Movement preview names/fingerprints or applying a previous valid receipt',async()=>{
  const subject=await hireEmployee(admin(),{person:{fullName:'Fictional import subject',primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(new Date(Date.now()-60*86400000)),employeeCode:'WF-IMPORT'});
  const future=todayInKualaLumpur(new Date(Date.now()+7*86400000));
  const csv=toCsv([['employee_code','event_type','effective_date','department_id'],['WF-IMPORT','transfer',future,b.deptB]]);
  const preview=await previewMovementImport(admin(),{companyId:b.companyId,csv});expect(preview.valid).toBe(1);
  const fingerprints=Object.fromEntries(preview.employees.map(row=>[row.employeeCode,row.fingerprint!]));
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(domainEvent).orderBy(domainEvent.id);
  await expect(movementImportCatalog(admin(),b.companyId)).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(movementImportDownloadData(admin(),{companyId:b.companyId})).rejects.toBeInstanceOf(WorkforceAccessError);
  const refused=await previewMovementImport(admin(),{companyId:b.companyId,csv});expect(refused.valid).toBe(0);
  expect(refused.employees).toHaveLength(1);expect(refused.employees[0]).toMatchObject({employeeCode:'WF-IMPORT',employmentId:null,name:null,fingerprint:null});
  const result=await commitMovementImport(admin(),{companyId:b.companyId,csv,selection:preview.selection,inputHash:preview.inputHash,fingerprints,acknowledgeExcluded:false});
  expect(result.imported).toBe(0);expect(result.failed).toBe(1);expect(result.employees[0]).toMatchObject({employmentId:null,name:null,fingerprint:null});
  expect(await owner.db.select().from(domainEvent).orderBy(domainEvent.id)).toEqual(before);
  expect((await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId)))[0]?.companyId).toBe(b.companyId);
  const records=[{employee_code:'WF-NEW',full_name:'Fictional never imported',email:'wf-new@example.invalid'}];
  await expect(validateEmployeeImport(admin(),{companyId:b.companyId,records})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(commitEmployeeImport(admin(),{companyId:b.companyId,records})).rejects.toBeInstanceOf(WorkforceAccessError);
 });
 it('requires an actual owner connection for a system sweep, never an empty user ID and claimed HR role',async()=>{
  const subject=await hireEmployee(admin(),{person:{fullName:'Fictional scheduled subject',primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(new Date(Date.now()-60*86400000))});
  const future=todayInKualaLumpur(new Date(Date.now()+7*86400000));
  await createMovementEvent(admin(),{employmentId:subject.employmentId,kind:'transfer',effectiveDate:future,departmentId:b.deptB,remarks:'Fictional already-admitted intent'});
  const system={...admin(),userId:undefined,personId:null} satisfies SessionContext;
  const [forged]=await withTenant(system,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_company(${b.companyId}::uuid,'workforce.maintain') as allowed`));expect(forged.allowed).toBe(false);
  await expect(withTenant(system,tx=>tx.execute(sql`select app.access_workforce_owner_company(${b.companyId}::uuid)`))).rejects.toThrow();
  const refused=await sweepDueMovements(system,{today:future});expect(refused).toMatchObject({applied:0,failed:1});
  // This is a pre-existing admitted dated intent. The owner job executes its ledger inputs; removing
  // its original author's later screen permission is not a cancellation of the recorded business event.
  const [actual]=await owner.withTenant(system,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_company(${b.companyId}::uuid,'workforce.maintain') as allowed`));expect(actual.allowed).toBe(true);
  const [actualPerson]=await owner.withTenant(system,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_person(${subject.personId}::uuid,'workforce.maintain') as allowed`));expect(actualPerson.allowed).toBe(true);
  const [fakePerson]=await withTenant(system,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_person(${subject.personId}::uuid,'workforce.maintain') as allowed`));expect(fakePerson.allowed).toBe(false);
  expect(await sweepDueMovements(system,{today:future},owner.withTenant)).toMatchObject({applied:1,failed:0});
  expect(await sweepDueMovements(system,{today:future},owner.withTenant)).toMatchObject({applied:0,failed:0});
  const rows=await owner.db.select({id:domainEvent.id}).from(domainEvent).where(eq(domainEvent.eventType,'employment.movement.applied')).orderBy(domainEvent.id);expect(rows).toHaveLength(1);
 });
 it('refuses direct register creation, edits and archives after maintenance denial without a partial event or state change',async()=>{
  const subject=await hire('Fictional register subject');
  const dependent=await registers.addDependent(admin(),{personId:subject.personId,fullName:'Fictional family member',relationship:'parent'});
  const qualification=await registers.addQualification(admin(),{employmentId:subject.employmentId,qualification:'Master',isHighest:true});
  const emergency=await registers.addEmergencyContact(admin(),{personId:subject.personId,fullName:'Fictional primary contact',priority:'primary'});
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const snapshot=async()=>({family:await owner.db.select().from(employeeDependent).orderBy(employeeDependent.id),
   qualifications:await owner.db.select().from(employeeQualification).orderBy(employeeQualification.id),
   contacts:await owner.db.select().from(personEmergencyContact).orderBy(personEmergencyContact.id),
   events:await owner.db.select().from(domainEvent).orderBy(domainEvent.id)});
  const before=await snapshot();
  const attempts=[
   ()=>registers.addDependent(admin(),{personId:subject.personId,fullName:'Not added',relationship:'parent'}),
   ()=>registers.updateDependent(admin(),{id:dependent.id,fullName:'Not changed'}),()=>registers.archiveDependent(admin(),{id:dependent.id}),
   ()=>registers.addQualification(admin(),{employmentId:subject.employmentId,qualification:'Bachelor'}),
   ()=>registers.updateQualification(admin(),{id:qualification.id,isHighest:false}),()=>registers.archiveQualification(admin(),{id:qualification.id}),
   ()=>registers.addEmergencyContact(admin(),{personId:subject.personId,fullName:'Not added',priority:'primary'}),
   ()=>registers.updateEmergencyContact(admin(),{id:emergency.id,fullName:'Not changed'}),()=>registers.archiveEmergencyContact(admin(),{id:emergency.id})];
  for(const attempt of attempts)await expect(attempt()).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await snapshot()).toEqual(before);
 });
 it('keeps register subjects immutable and guards SQL/direct-owner archival',async()=>{
  const subject=await hire('Fictional retained register owner'),other=await hire('Fictional different register owner');
  const family=await registers.addDependent(admin(),{personId:subject.personId,fullName:'Fictional retained family',relationship:'parent'});
  const qualification=await registers.addQualification(admin(),{employmentId:subject.employmentId,qualification:'Master',isHighest:true});
  const contact=await registers.addEmergencyContact(admin(),{personId:subject.personId,fullName:'Fictional retained contact',priority:'primary'});
  const snapshot=async()=>({family:await owner.db.select().from(employeeDependent).orderBy(employeeDependent.id),qualifications:await owner.db.select().from(employeeQualification).orderBy(employeeQualification.id),contacts:await owner.db.select().from(personEmergencyContact).orderBy(personEmergencyContact.id),events:await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)});
  const before=await snapshot();
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeDependent).set({personId:other.personId}).where(eq(employeeDependent.id,family.id))));
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeQualification).set({employmentId:other.employmentId}).where(eq(employeeQualification.id,qualification.id))));
  await sqlRefusal(withTenant(admin(),tx=>tx.update(personEmergencyContact).set({personId:other.personId}).where(eq(personEmergencyContact.id,contact.id))));
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeDependent).set({archivedAt:new Date()}).where(eq(employeeDependent.id,family.id))));
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeQualification).set({archivedAt:new Date()}).where(eq(employeeQualification.id,qualification.id))));
  await expect(archiveDependentOwner(admin(),{id:family.id})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(archiveQualificationOwner(admin(),{id:qualification.id})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await snapshot()).toEqual(before);
 });
 it('guards physical profile/register values and removal without treating a claimed bypass as permission',async()=>{
  const subject=await hire('Fictional SQL value subject');
  const family=await registers.addDependent(admin(),{personId:subject.personId,fullName:'Fictional retained parent',relationship:'parent'});
  const qualification=await registers.addQualification(admin(),{employmentId:subject.employmentId,qualification:'Master'});
  const contact=await registers.addEmergencyContact(admin(),{personId:subject.personId,fullName:'Fictional retained primary',priority:'primary'});
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const snapshot=async()=>({person:await owner.db.select().from(person).where(eq(person.id,subject.personId)),
   family:await owner.db.select().from(employeeDependent),qualification:await owner.db.select().from(employeeQualification),
   contact:await owner.db.select().from(personEmergencyContact),events:await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)});
  const before=await snapshot();
  for(const operation of ['person','family','qualification','contact','delete-family','delete-qualification','delete-contact'] as const){
   await sqlRefusal(withTenant(admin(),async tx=>{
    await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true),set_config('app.profile_write_approved','true',true)`);
    if(operation==='person')await tx.update(person).set({firstName:'Must not persist',gender:'female'}).where(eq(person.id,subject.personId));
    else if(operation==='family')await tx.update(employeeDependent).set({phone:'Must not persist'}).where(eq(employeeDependent.id,family.id));
    else if(operation==='qualification')await tx.update(employeeQualification).set({institute:'Must not persist'}).where(eq(employeeQualification.id,qualification.id));
    else if(operation==='contact')await tx.update(personEmergencyContact).set({mobilePhone:'Must not persist'}).where(eq(personEmergencyContact.id,contact.id));
    else if(operation==='delete-family')await tx.delete(employeeDependent).where(eq(employeeDependent.id,family.id));
    else if(operation==='delete-qualification')await tx.delete(employeeQualification).where(eq(employeeQualification.id,qualification.id));
    else await tx.delete(personEmergencyContact).where(eq(personEmergencyContact.id,contact.id));
   }));
  }
  await sqlRefusal(withTenant(admin(),tx=>tx.execute(sql`insert into app.access_profile_value_approval(xact_id,tenant_id,request_id,user_id,proposal_hash,route_hash,approved,audited)
   values(pg_current_xact_id(),${b.tenantId}::uuid,${randomUUID()}::uuid,${b.adminUserId}::uuid,'forged','forged',true,true)`)));
  expect(await snapshot()).toEqual(before);
 });
 it('checks document services, raw CRUD and actual download routes while retaining independent self reads',async()=>{
  const subject=await hire('Fictional file owner'),other=await hire('Fictional unrelated subject');
  const userId=await createAppUser(b.tenantId,subject.personId,'employee');
  const own={...admin(),userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const content=Buffer.from('Fictional Workforce supporting file');
  const document=await addEmployeeDocument(admin(),{employmentId:subject.employmentId,title:'Fictional support',fileName:'fictional.txt',mimeType:'text/plain',content});
  // Even access to both employments does not make the file's retained subject mutable.
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeDocument).set({employmentId:other.employmentId}).where(eq(employeeDocument.id,document.id))));
  const download=async(ctx:SessionContext,id=subject.employmentId)=>{routeSession.ctx=ctx;return downloadDocument(new Request(`http://localhost/admin/personnel/${id}/document/${document.id}`),{params:Promise.resolve({employmentId:id,docId:document.id})});};
  expect(Buffer.from(await(await download(admin())).arrayBuffer())).toEqual(content);
  const eventsBeforeWrongUrl=await owner.db.select({id:domainEvent.id}).from(domainEvent).where(eq(domainEvent.eventType,'employee-document.downloaded')).orderBy(domainEvent.id);
  expect((await download(admin(),other.employmentId)).status).toBe(404);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).where(eq(domainEvent.eventType,'employee-document.downloaded')).orderBy(domainEvent.id)).toEqual(eventsBeforeWrongUrl);
  await activate();await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  const before=await owner.db.select().from(employeeDocument).where(eq(employeeDocument.id,document.id));
  await expect(updateEmployeeDocumentMeta(admin(),{documentId:document.id,title:'Not changed'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(replaceEmployeeDocumentContent(admin(),{documentId:document.id,fileName:'not-changed.txt',mimeType:'text/plain',content:Buffer.from('Not changed')})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(deleteEmployeeDocument(admin(),{documentId:document.id})).rejects.toBeInstanceOf(WorkforceAccessError);
  await expect(addEmployeeDocument(admin(),{employmentId:subject.employmentId,title:'Not added',fileName:'not-added.txt',mimeType:'text/plain',content})).rejects.toBeInstanceOf(WorkforceAccessError);
  for(const ctx of [admin(),own]){
   expect(await withTenant(ctx,tx=>tx.update(employeeDocument).set({title:'Not changed'}).where(eq(employeeDocument.id,document.id)).returning({id:employeeDocument.id}))).toEqual([]);
   expect(await withTenant(ctx,tx=>tx.delete(employeeDocument).where(eq(employeeDocument.id,document.id)).returning({id:employeeDocument.id}))).toEqual([]);
   await expect(withTenant(ctx,tx=>tx.insert(employeeDocument).values({tenantId:b.tenantId,employmentId:subject.employmentId,title:'Not added',fileName:'not-added.txt',mimeType:'text/plain',sizeBytes:content.length,content}))).rejects.toThrow();
  }
  expect(await owner.db.select().from(employeeDocument).where(eq(employeeDocument.id,document.id))).toEqual(before);
  await override(b.adminUserId,'workforce.view',b.companyId,'deny');
  expect(await listEmployeeDocuments(admin(),subject.employmentId)).toEqual([]);expect(await getEmployeeDocument(admin(),document.id)).toBeNull();
  expect((await download(admin())).status).toBe(404);
  expect(await withTenant(admin(),tx=>tx.select().from(employeeDocument).where(eq(employeeDocument.id,document.id)))).toEqual([]);
  expect(Buffer.from(await(await download(own)).arrayBuffer())).toEqual(content);
 });
 it('projects an authorized colleague for a real non-HR reader without granting raw personnel or financial rows',async()=>{
  const self=await hire('Fictional scoped reader'),colleague=await hire('Fictional projected colleague');
  await setCompensation(admin(),{employmentId:colleague.employmentId,basicSalary:3123.45,effectiveFrom:todayInKualaLumpur()});
  expect(await owner.db.select({id:compensation.id}).from(compensation).where(eq(compensation.employmentId,colleague.employmentId))).toHaveLength(1);
  const userId=await createAppUser(b.tenantId,self.personId,'employee');
  const ctx={...admin(),userId,personId:self.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  await activate();expect((await page(ctx)).total).toBe(0);
  expect(await workforceViewScope(ctx)).toEqual({companyIds:[],canOpen:false});
  await override(userId,'workforce.view',b.companyId,'allow');
  expect((await page(ctx)).rows.map(row=>row.employmentId).sort()).toEqual([self.employmentId,colleague.employmentId].sort());
  expect((await countEmployeesByStatus(ctx,{companyIds:[b.companyId]},'workforce')).total).toBe(2);
  expect(await workforceViewScope(ctx)).toEqual({companyIds:[b.companyId],canOpen:true});
  const detail=await workforceRecord(ctx,colleague.employmentId);expect(detail?.employment.employmentId).toBe(colleague.employmentId);
  expect(detail?.profile.fullName).toBe('Fictional projected colleague');
  expect(Object.keys(detail!).sort()).toEqual(['employment','profile']);
  expect(Object.keys(detail!.profile).sort()).toEqual(WORKFORCE_PROFILE_FIELDS.map(field=>field.key).sort());
  for(const forbidden of ['paymentMethod','payrollPolicyId','isTestRecord','costAllocation','terminationReason'])expect(detail!.employment).not.toHaveProperty(forbidden);
  expect(JSON.stringify(detail)).not.toContain('3123.45');
  expect((await listWorkforcePickOptions(ctx,[b.companyId])).map(row=>row.employmentId).sort()).toEqual([self.employmentId,colleague.employmentId].sort());
  expect(await withTenant(ctx,tx=>tx.select().from(employment).where(eq(employment.id,colleague.employmentId)))).toEqual([]);
  expect(await withTenant(ctx,tx=>tx.select().from(person).where(eq(person.id,colleague.personId)))).toEqual([]);
  expect(await withTenant(ctx,tx=>tx.execute(sql`select * from compensation where employment_id=${colleague.employmentId}::uuid`))).toEqual([]);
  await override(userId,'workforce.view',b.companyId,'deny');expect((await page(ctx)).total).toBe(0);
  expect(await workforceRecord(ctx,colleague.employmentId)).toBeNull();expect(await workforceViewScope(ctx)).toEqual({companyIds:[],canOpen:false});
  // The person's existing own-record source remains separate from the revoked Workforce grant.
  expect(await withTenant(ctx,tx=>tx.select({id:employment.id}).from(employment).where(eq(employment.id,self.employmentId)))).toEqual([{id:self.employmentId}]);
 });
 it('admits a real non-HR identifier command with audit/CAS while keeping raw employee and salary rows private',async()=>{
  const self=await hire('Fictional maintenance user'),colleague=await hire('Fictional maintenance target');
  await setCompensation(admin(),{employmentId:colleague.employmentId,basicSalary:3000,effectiveFrom:todayInKualaLumpur()});
  const salaryFixture=await owner.db.select({basicSalary:compensation.basicSalary}).from(compensation).where(eq(compensation.employmentId,colleague.employmentId));
  expect(salaryFixture).toHaveLength(1);expect(Number(salaryFixture[0].basicSalary)).toBe(3000);
  const userId=await createAppUser(b.tenantId,self.personId,'employee');
  const ctx={...admin(),userId,personId:self.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const [before]=await owner.db.select().from(employment).where(eq(employment.id,colleague.employmentId));
  await activate();await override(userId,'workforce.view',b.companyId,'allow');await override(userId,'workforce.maintain',b.companyId,'allow');
  expect(await workforceCommandAccess(ctx,colleague.employmentId)).toBe(true);
  expect(await setEmployeeCode(ctx,{employmentId:colleague.employmentId,employeeCode:'wf-nonhr-code',expectedCode:before.employeeCode})).toEqual({id:colleague.employmentId,changed:true});
  expect((await owner.db.select().from(employment).where(eq(employment.id,colleague.employmentId)))[0]).toEqual({...before,employeeCode:'WF-NONHR-CODE'});
  const events=()=>owner.db.select().from(domainEvent).where(and(eq(domainEvent.aggregateId,colleague.employmentId),eq(domainEvent.eventType,'employment.employee-code.set'))).orderBy(domainEvent.id);
  expect(await events()).toMatchObject([{actorType:'user',actorId:userId,subjectEmploymentId:colleague.employmentId,payload:{before:{employeeCode:before.employeeCode},after:{employeeCode:'WF-NONHR-CODE'}}}]);
  expect(await setEmployeeCode(ctx,{employmentId:colleague.employmentId,employeeCode:'WF-NONHR-CODE',expectedCode:'WF-NONHR-CODE'})).toMatchObject({changed:false});
  await expect(setEmployeeCode(ctx,{employmentId:colleague.employmentId,employeeCode:'WF-STALE',expectedCode:before.employeeCode})).rejects.toBeInstanceOf(WorkforceRecordChangedError);
  expect(await events()).toHaveLength(1);
  expect(await withTenant(ctx,tx=>tx.select({id:employment.id}).from(employment).where(eq(employment.id,colleague.employmentId)))).toEqual([]);
  expect(await withTenant(ctx,tx=>tx.select({id:compensation.id}).from(compensation).where(eq(compensation.employmentId,colleague.employmentId)))).toEqual([]);
  expect(await withTenant(ctx,tx=>tx.update(employment).set({employeeCode:'WF-RAW-FORBIDDEN',isTestRecord:true}).where(eq(employment.id,colleague.employmentId)).returning({id:employment.id}))).toEqual([]);
  expect((await owner.db.select({role:roleAssignment.role}).from(roleAssignment).where(eq(roleAssignment.appUserId,userId))).map(row=>row.role)).toEqual(['employee']);
  const forged={...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  await expect(setEmployeeCode(forged,{employmentId:colleague.employmentId,employeeCode:'WF-FORGED'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await override(userId,'workforce.view',b.companyId,'deny');
  expect(await workforceCommandAccess(ctx,colleague.employmentId)).toBe(false);
  await expect(setEmployeeCode(ctx,{employmentId:colleague.employmentId,employeeCode:'WF-NO-VIEW'})).rejects.toBeInstanceOf(WorkforceAccessError);
  await override(userId,'workforce.view',b.companyId,'allow');await override(userId,'workforce.maintain',b.companyId,'deny');
  await expect(setEmployeeCode(ctx,{employmentId:colleague.employmentId,employeeCode:'WF-REVOKED'})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await events()).toHaveLength(1);
 });
 it('enforces canonical identifier shape at the SQL command boundary without accepting another field assignment',async()=>{
  const subject=await hire('Fictional SQL code shape');
  const [before]=await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId));
  for(const code of ['', 'wf-lowercase', 'WF SPACE','WF_UNDERSCORE','A'.repeat(31),'WF-CODE, is_test_record=true']){
   await sqlRefusal(withTenant(admin(),tx=>tx.execute(sql`select app.access_workforce_set_employee_code(${subject.employmentId}::uuid,${code},NULL)`)),'23514');
  }
  expect((await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId)))[0]).toEqual(before);
  const code='WF'+'A'.repeat(28);
  await expect(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:code})).resolves.toMatchObject({changed:true});
  expect((await owner.db.select({code:employment.employeeCode}).from(employment).where(eq(employment.id,subject.employmentId)))[0]?.code).toBe(code);
 });
 it('uses the same employment/draft code claims and rolls back the bounded command if its audit fails',async()=>{
  const subject=await hire('Fictional bounded code target');
  await owner.db.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,reservedEmployeeCode:'WF-DRAFT-HELD',data:{},label:'Fictional held ID'});
  const [before]=await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId));
  await expect(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'WF-DRAFT-HELD'})).rejects.toThrow('reserved by a draft');
  await owner.db.execute(sql.raw("CREATE FUNCTION app.test_workforce_code_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='employment.employee-code.set' THEN RAISE EXCEPTION 'Fictional code audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$"));
  try{
   await owner.db.execute(sql.raw('CREATE TRIGGER test_workforce_code_audit_refusal BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_workforce_code_audit_refusal()'));
   await sqlRefusal(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'WF-AUDIT-REFUSAL'}),'P0001');
  }finally{
   await owner.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_workforce_code_audit_refusal ON domain_event'));
   await owner.db.execute(sql.raw('DROP FUNCTION app.test_workforce_code_audit_refusal()'));
  }
  expect((await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId)))[0]).toEqual(before);
  expect(await owner.db.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.aggregateId,subject.employmentId),eq(domainEvent.eventType,'employment.employee-code.set')))).toEqual([]);
 });
 it('commits only one competing identifier correction and one code-change event',async()=>{
  const first=await hire('Fictional first competing ID'),second=await hire('Fictional second competing ID');
  const results=await Promise.allSettled([setEmployeeCode(admin(),{employmentId:first.employmentId,employeeCode:'WF-COMPETING'}),setEmployeeCode(admin(),{employmentId:second.employmentId,employeeCode:'WF-COMPETING'})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  const retained=await owner.db.select({id:employment.id}).from(employment).where(eq(employment.employeeCode,'WF-COMPETING')).orderBy(employment.id);expect(retained).toHaveLength(1);
  expect(await owner.db.select({subject:domainEvent.subjectEmploymentId}).from(domainEvent).where(eq(domainEvent.eventType,'employment.employee-code.set')).orderBy(domainEvent.id)).toEqual([{subject:retained[0].id}]);
 });
 it('rejects stale real role assignments and forged role/scope claims without treating a capability grant as HR',async()=>{
  const subject=await hire('Fictional scope subject');await activate();
  const userId=await createAppUser(b.tenantId,subject.personId,'employee');
  const forged={...admin(),userId,personId:subject.personId};
  await override(userId,'workforce.view',b.companyId,'allow');
  expect((await page(forged)).total).toBe(0);expect(await employeeDetail(forged,subject.employmentId,'workforce')).toBeNull();
  const [scopedUser]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`scoped_${randomUUID()}`}).returning({id:appUser.id});
  const [grant]=await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:scopedUser.id,role:'hr_admin',companyId:b.companyId}).returning({id:roleAssignment.id});
  const scoped={...admin(),userId:scopedUser.id,personId:null,grants:[{role:'hr_admin',companyId:b.companyId}]} satisfies SessionContext;
  expect((await page(scoped)).total).toBe(1);
  await owner.db.delete(roleAssignment).where(eq(roleAssignment.id,grant.id));expect((await page(scoped)).total).toBe(0);
 });
 it('does not expose a real foreign tenant through subject or company helper calls',async()=>{
  const foreign=await seedBase();await activate();
  const subject=await hireEmployee({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{person:{fullName:'Foreign real record',primaryEmail:`${randomUUID()}@example.invalid`},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  expect(await employeeDetail(admin(),subject.employmentId,'workforce')).toBeNull();
  const [row]=await withTenant(admin(),tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${subject.employmentId}::uuid,'workforce.view') as allowed`));expect(row.allowed).toBe(false);
  expect(await workforceCompanies(admin())).not.toContain(foreign.companyId);
  const before=await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId));
  await expect(setEmployeeCode(admin(),{employmentId:subject.employmentId,employeeCode:'WF-FOREIGN-FORBIDDEN'})).rejects.toBeInstanceOf(WorkforceAccessError);
  expect(await owner.db.select().from(employment).where(eq(employment.id,subject.employmentId))).toEqual(before);
 });
 it('retains an author’s independent draft read/discard source but lets an explicit denial override it',async()=>{
  const author=await hire('Fictional draft author'),userId=await createAppUser(b.tenantId,author.personId,'employee');
  const ctx={...adminCtx(b),userId,personId:author.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} satisfies SessionContext;
  const [draft]=await owner.db.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:author.personId,label:'Own retained draft',data:{}}).returning({id:employeeDraft.id});
  const read=()=>withTenant(ctx,tx=>tx.select({id:employeeDraft.id}).from(employeeDraft).where(eq(employeeDraft.id,draft.id)));
  expect(await read()).toEqual([{id:draft.id}]);await activate();expect(await read()).toEqual([{id:draft.id}]);
  await override(userId,'workforce.view',b.companyId,'deny');expect(await read()).toEqual([]);
  await override(userId,'workforce.view',b.companyId,null);await override(userId,'workforce.maintain',b.companyId,'deny');
  expect(await withTenant(ctx,tx=>tx.delete(employeeDraft).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([]);
  await override(userId,'workforce.maintain',b.companyId,null);
  expect(await withTenant(ctx,tx=>tx.delete(employeeDraft).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([{id:draft.id}]);
 });
 it('binds draft authorship to the actual user and keeps that retained fact immutable',async()=>{
  const subject=await hire('Fictional other possible author');await activate();
  await sqlRefusal(withTenant(admin(),tx=>tx.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:subject.personId,label:'Forged author',data:{}})));
  const [draft]=await withTenant(admin(),tx=>tx.insert(employeeDraft).values({tenantId:b.tenantId,companyId:b.companyId,createdByPersonId:null,label:'Actual personless administrator',data:{}}).returning({id:employeeDraft.id}));
  await sqlRefusal(withTenant(admin(),tx=>tx.update(employeeDraft).set({createdByPersonId:subject.personId}).where(eq(employeeDraft.id,draft.id))));
  expect((await owner.db.select({author:employeeDraft.createdByPersonId}).from(employeeDraft).where(eq(employeeDraft.id,draft.id)))[0]?.author).toBeNull();
  await override(b.adminUserId,'workforce.maintain',b.companyId,'deny');
  expect(await withTenant(admin(),tx=>tx.update(employeeDraft).set({label:'Not applied'}).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([]);
  expect(await withTenant(admin(),tx=>tx.delete(employeeDraft).where(eq(employeeDraft.id,draft.id)).returning({id:employeeDraft.id}))).toEqual([]);
 });
});
