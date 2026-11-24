/** ADR 0181 J2, imports: the employee import's set path. A group of consecutive employee rows of the common shape (a
 * new person hired into one Malaysian company with the statutory profile, the tax selection, the first salary record
 * and the IC-derived date of birth; no family, register, allocation or other optional block) is written in a few set
 * statements instead of about a hundred statements per row.
 *
 * The per-row path (core/import.ts applyEmployeeImportRowTx: hireEmployee, initializeHiredStatutoryMY,
 * setPersonComplianceFields, setCompensation, recordImportItemTx) stays the owner of every rule. This path calls the
 * same owners' pure parts (hireEmploymentValues, hiredEventPayload, hireOpeningGrantDays, prepareNewStatutoryProfileMY,
 * statutoryProfileEventPayloadMY, hiredTaxSelectionValuesMY, compensationRevisionTerms, adminComplianceDateOfBirth
 * and their payload builders), the same tenant-level lock and authority owners once per group, the same per-subject
 * lock keys in one statement, the same authority checks over the group in one statement each, and writes with
 * multi-row statements. The events of the group are appended in ONE statement in exactly the per-row order (each
 * row's employment.hired, employee.tax-scheme.selected, statutory.my.created, person.updated, compensation.set), so
 * the audit chain carries the same events in the same order.
 *
 * It never decides a refusal. Anything the per-row path would refuse or do differently (a failed check, an existing
 * row where a new one is expected, a lock another transaction holds, any database refusal) throws `SetPathDeclined`
 * or the database's own error; the caller rolls the group's savepoint back and the rows take the per-row path, which
 * then records exactly its own outcome. Proven by test/employee-import-set-equivalence.test.ts; a change to a covered
 * owner must keep this path in step or that test fails. */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {actorOf,appendEvents,type AppendEventArgs} from '../db/events';
import {assignment,businessUnit,company,compensation,costCenter,department,employeeStatutoryMy,employment,employmentTaxSelectionMy,importAttemptItem,jobGrade,leaveLedger,leaveType,person,position} from '../db/schema';
import {hireEmploymentValues,hiredEventPayload,hireOpeningGrantDays} from './org';
import {compensationRevisionTerms,compensationSetEventPayload,markPayrollRunsForCompensationSetTx} from './comp';
import {adminComplianceDateOfBirth,adminComplianceEventPayload} from './profile';
import {packFor} from '../localization/registry';
import {assertWorkforceCompanyTx} from './workforce-access';
import {joinWorkforceBarrierTx,lockEmploymentLeaveDependenciesTx} from './workforce-lock-mode';
import {lockLeaveDependencyConfigurationTx,lockLeaveDependenciesWaitTx} from './leave-dependency-lock';
import {lockLabelCriteriaTx,labelUsableByCompany} from './system-labels';
import {withSystemLabelCompanyTx} from './system-label-selection';
import {deriveCompanyOrganisationTx} from './company-organisation';
import {organisationBusinessUnit,organisationManagedTx} from './organisation-write-policy';
import {requireEmployeeCode} from '../lib/employee-code';
import {buildTemplateEntitlementResolver} from './entitlement-template';
import {leaveTypeRuleColumns} from './leave';
import {lockAccessConfigurationTx,lockProfileValueSharedTx} from './access-configuration-lock';
import {lockPayrollInputsTx} from './payroll-inputs-lock';
import {isCarrierPrincipalCurrentTx} from './carrier-principal';
import type {AllocationImportPreview} from '../lib/cost-allocation-import';
import type {EmployeeImportPlanStep} from './import';
import type {EmployeeFullItemState} from './employee-import-history';

export type EmployeeHireStep=Extract<EmployeeImportPlanStep,{kind:'employee'}>;
/** The set path does not write this group; its rows take the per-row path. The reason is a closed label. */
export class SetPathDeclined extends Error{constructor(readonly reason:string){super(`Set path declined: ${reason}`);this.name='SetPathDeclined';}}
const decline=(reason:string):never=>{throw new SetPathDeclined(reason);};

/** The common shape: what this path writes. Every other row (and every row of a file with cost allocations) takes the
 * per-row path. */
export function isEmployeeImportSetShape(p:EmployeeImportPlanStep,allocationPreview:AllocationImportPreview|undefined):p is EmployeeHireStep{
 if(p.kind!=='employee'||p.family.length>0||allocationPreview)return false;
 const r=p.row;
 if(!packFor(r.country)?.statutory.hireGroup||!r.hire.employeeCode?.trim())return false;
 return !(r.oldIcNumber||r.bankExtra||r.operations||r.statutoryPatch||r.payrollPolicyId||r.scheduleGroupId||r.profile||r.passport||r.compliance||r.employmentInfo);
}

const uuidList=(ids:readonly string[])=>sql`${`{${ids.join(',')}}`}::uuid[]`;
const textList=(values:readonly string[])=>sql`${`{${values.map(v=>`"${v.replace(/["\\]/g,'\\$&')}"`).join(',')}}`}::text[]`;
/** Exclusive (or shared) transaction advisory locks on these keys in one statement, without waiting. The keys name
 * subjects this transaction created (new people and employments), which no other transaction can know; a key that is
 * held all the same declines the group, and the per-row path then waits for it with its bounded wait. */
async function tryAdvisoryLocksTx(tx:Tx,keys:readonly string[],shared=false){
 if(!keys.length)return;
 const [row]=await tx.execute<{ok:boolean}>(shared
  ?sql`select coalesce(bool_and(pg_try_advisory_xact_lock_shared(hashtextextended(k,0))),true) as ok from unnest(${textList(keys)}) with ordinality as u(k,n)`
  :sql`select coalesce(bool_and(pg_try_advisory_xact_lock(hashtextextended(k,0))),true) as ok from unnest(${textList(keys)}) with ordinality as u(k,n)`);
 if(row?.ok!==true)decline('subject-lock-held');
}
/** Every value true, in one statement over the group (the per-row path asks once per row). */
async function allTrue(tx:Tx,query:ReturnType<typeof sql>,reason:string){
 const [row]=await tx.execute<{ok:boolean|null}>(query);
 if(row?.ok!==true)decline(reason);
}

export type EmployeeHireGroupResult={employmentId:string;personId:string;family:0};
type Written={step:EmployeeHireStep;personId:string;employmentId:string;code:string};

/** Writes the group (all rows of one company, in step order) and returns each row's step result, in order. */
export async function applyEmployeeHireGroupTx(tx:Tx,ctx:SessionContext,steps:readonly EmployeeHireStep[],env:{attemptId:string}):Promise<EmployeeHireGroupResult[]>{
 const tenant=ctx.tenantId;
 const companyId=steps[0].row.hire.companyId;
 if(steps.some(s=>s.row.hire.companyId!==companyId))decline('companies');
 const actor=actorOf(ctx);
 // The row's country pack (the per-row path's requirePackFor(row.country)), through the registry.
 const pack=packFor(steps[0].row.country);
 const hireGroup=pack?.statutory.hireGroup;
 if(!pack||!hireGroup||!pack.statutory.initializeForHire||steps.some(s=>s.row.country!==steps[0].row.country))decline('pack');
 // In-memory rules first: anything that throws here would throw in the per-row path too.
 const rows=steps.map(step=>{
  const r=step.row;
  const code=requireEmployeeCode(r.hire.employeeCode);
  const statutoryInput={personId:'',...r.statutory};
  const dob=pack!.statutory.dobFromIC(r.statutory.icNumber);
  const dobValue=dob?adminComplianceDateOfBirth(dob):null;
  if(dob&&dobValue===undefined)decline('date-of-birth');
  const compensationInput={employmentId:'',basicSalary:r.basicSalary,monthlyAllowance:r.monthlyAllowance,payMode:r.payMode,paymentTerm:r.paymentTerm,rateAmount:r.rateAmount,remarks:r.salaryRemarks,effectiveFrom:r.effectiveFrom};
  const terms=compensationRevisionTerms(compensationInput,undefined);
  // The statutory values the owner would write for a person with no profile yet (initializeHiredStatutoryMY
  // defaults SKBBK on for a genuinely new profile).
  const statutory=hireGroup!.prepareNewProfile({...statutoryInput,subjectToSkbbk:(r.statutory as {subjectToSkbbk?:boolean}).subjectToSkbbk??true});
  return{step,code,dob:dobValue??null,compensationInput,terms,statutory,personId:randomUUID(),employmentId:randomUUID()};
 });
 if(new Set(rows.map(r=>r.code)).size!==rows.length)decline('duplicate-code');
 const roles=ctx.roles??[];
 if(!(roles.includes('super_admin')||roles.includes('hr_admin')))decline('not-administrator');
 const personIds=rows.map(r=>r.personId),employmentIds=rows.map(r=>r.employmentId);
 const events:AppendEventArgs[][]=rows.map(()=>[]);

 // ── hireEmployee, for the group ─────────────────────────────────────────────────────────────────────────────
 const written:Written[]=await withSystemLabelCompanyTx(tx,companyId,async()=>{
  await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
  await lockLeaveDependencyConfigurationTx(tx,tenant);
  await lockLabelCriteriaTx(tx,tenant);
  const [hireCompany]=await tx.select({id:company.id,country:company.country}).from(company).where(and(eq(company.tenantId,tenant),eq(company.id,companyId),isNull(company.archivedAt),sql`app.is_admin_for(${company.id})`)).for('share');
  if(!hireCompany)decline('company');
  const managed=await organisationManagedTx(tx);
  const organisationOn=new Map<string,Awaited<ReturnType<typeof deriveCompanyOrganisationTx>>>();
  for(const day of new Set(rows.map(r=>r.step.row.hire.hiredOn)))organisationOn.set(day,await deriveCompanyOrganisationTx(tx,ctx,{companyId,asOf:day}));
  const hires=rows.map(r=>{const h=r.step.row.hire;return{...h,businessUnitId:organisationBusinessUnit(organisationOn.get(h.hiredOn)!,managed,h.businessUnitId)??undefined};});
  // Each distinct label once: active (row lock for share, as the per-row check) and usable by the company.
  const labels:[typeof businessUnit|typeof department|typeof position|typeof costCenter,'business_unit'|'department'|'position'|'cost_center',string][]=[];
  const seen=new Set<string>();
  for(const h of hires)for(const [table,id,kind] of [[businessUnit,h.businessUnitId,'business_unit'],[department,h.departmentId,'department'],[position,h.positionId,'position'],[costCenter,h.costCenterId,'cost_center']] as const){
   if(!id||seen.has(kind+id))continue;seen.add(kind+id);labels.push([table,kind,id]);
  }
  for(const [table,kind,id] of labels){
   const [active]=await tx.select({id:table.id}).from(table).where(and(eq(table.tenantId,tenant),eq(table.id,id),isNull(table.archivedAt))).for('share');
   if(!active||!(await labelUsableByCompany(tx,tenant,kind,id,companyId)))decline('label');
  }
  const departmentUnits=new Map<string,string|null>();
  for(const h of hires)if(h.businessUnitId&&!departmentUnits.has(h.departmentId)){const [d]=await tx.select({businessUnitId:department.businessUnitId}).from(department).where(eq(department.id,h.departmentId));departmentUnits.set(h.departmentId,d?.businessUnitId??null);}
  for(const h of hires)if(h.businessUnitId){const unit=departmentUnits.get(h.departmentId);if(unit&&unit!==h.businessUnitId)decline('department-unit');}
  for(const gradeId of new Set(hires.map(h=>h.gradeId).filter((g):g is string=>!!g))){
   const [grade]=await tx.select({id:jobGrade.id}).from(jobGrade).where(and(eq(jobGrade.tenantId,tenant),eq(jobGrade.id,gradeId),isNull(jobGrade.archivedAt),sql`app.system_label_scope_applies(${jobGrade.scopeCompanyIds},${companyId}::uuid)`)).for('share');
   if(!grade)decline('grade');
  }
  await tx.insert(person).values(rows.map(r=>({id:r.personId,tenantId:tenant,fullName:r.step.row.hire.person.fullName,primaryEmail:r.step.row.hire.person.primaryEmail,phone:r.step.row.hire.person.phone??null,nationality:null})));
  // The Employee ID reservation owner, for every code of the group in one statement (a code is the group's own
  // only once: duplicates were declined above, and the unique index refuses any other collision).
  const claims=await tx.execute<{claim:string|null}>(sql`select app.employee_code_claim(${tenant}::uuid,c,null::uuid,null::uuid) as claim from unnest(${textList(rows.map(r=>r.code))}) with ordinality as u(c,n) order by n`);
  if(claims.length!==rows.length||claims.some(c=>c.claim!==null))decline('employee-code');
  await tx.insert(employment).values(rows.map((r,i)=>({id:r.employmentId,...hireEmploymentValues(tenant,r.personId,hires[i],r.code)})));
  await tx.insert(assignment).values(rows.map((r,i)=>({tenantId:tenant,employmentId:r.employmentId,departmentId:hires[i].departmentId,businessUnitId:hires[i].businessUnitId??null,positionId:hires[i].positionId??null,
   costCenterId:hires[i].costCenterId??null,employmentType:hires[i].employmentType,companyId,validFrom:hires[i].hiredOn,validTo:null})));
  // Opening leave grants: the same owner rule per row and type, the template resolver once per hire date.
  const grantTypes=hires[0].grantLeaveTypes??[];
  if(hires.some(h=>JSON.stringify(h.grantLeaveTypes??[])!==JSON.stringify(grantTypes)))decline('grant-types');
  if(grantTypes.length){
   const pack=packFor(hireCompany.country);
   if(pack){
    const typeRuleRows=await tx.select({id:leaveType.id,...leaveTypeRuleColumns}).from(leaveType).where(inArray(leaveType.id,grantTypes.map(t=>t.id)));
    const rulesById=new Map(typeRuleRows.map(r=>[r.id,r]));
    const ledger:(typeof leaveLedger.$inferInsert)[]=[];
    const resolvers=new Map<string,Awaited<ReturnType<typeof buildTemplateEntitlementResolver>>>();
    for(const day of new Set(hires.map(h=>h.hiredOn)))resolvers.set(day,await buildTemplateEntitlementResolver(tx,{employmentIds:rows.filter((_,i)=>hires[i].hiredOn===day).map(r=>r.employmentId),leaveTypeIds:grantTypes.map(t=>t.id),asOf:day}));
    rows.forEach((r,i)=>{for(const lt of grantTypes){
     const grant=hireOpeningGrantDays({pack,leaveType:lt,templateBand:resolvers.get(hires[i].hiredOn)!.bandFor(r.employmentId,lt.id,0),rules:rulesById.get(lt.id),hiredOn:hires[i].hiredOn});
     if(grant!==null)ledger.push({tenantId:tenant,employmentId:r.employmentId,leaveTypeId:lt.id,entryType:'accrual',days:grant.toFixed(2),effectiveOn:hires[i].hiredOn});
    }});
    if(ledger.length)await tx.insert(leaveLedger).values(ledger);
   }
  }
  const information=new Map((await tx.select().from(employment).where(inArray(employment.id,employmentIds))).map(row=>[row.id,row]));
  rows.forEach((r,i)=>{
   const info=information.get(r.employmentId);if(!info)decline('employment-read');
   events[i].push({tenantId:tenant,aggregateType:'employment',aggregateId:r.employmentId,eventType:'employment.hired',actor,subjectEmploymentId:r.employmentId,
    payload:hiredEventPayload(hires[i],r.personId,hires[i].provisionalEndOn??null,info as unknown as Record<string,unknown>)});
  });
  // Tax selection (initializeHiredTaxSelectionMYTx): the statutory interval, the employment rows, the company, the
  // per-employment scheme locks, then one insert.
  if(!packFor(hireCompany.country)?.statutory.initializeHiredTaxSelectionTx||hireCompany.country!=='MY')decline('tax-selection-pack');
  await lockStatutoryGroupTx(tx,ctx,rows.map(r=>({personId:r.personId,employmentId:r.employmentId})));
  const statutoryRows=await tx.select({personId:employeeStatutoryMy.personId}).from(employeeStatutoryMy).where(and(inArray(employeeStatutoryMy.personId,personIds),eq(employeeStatutoryMy.tenantId,tenant))).for('update');
  if(statutoryRows.length)decline('statutory-exists');
  const locked=await tx.select({id:employment.id,personId:employment.personId,companyId:employment.companyId}).from(employment).where(and(inArray(employment.id,employmentIds),eq(employment.tenantId,tenant))).for('no key update');
  if(locked.length!==rows.length||locked.some(e=>e.companyId!==companyId))decline('tax-selection-context');
  await allTrue(tx,sql`select app.is_admin_for(${companyId}::uuid) and app.is_admin_for(${companyId}::uuid) as ok`,'tax-selection-admin');
  const [taxCompany]=await tx.select({companyName:company.legalName}).from(company).where(and(eq(company.id,companyId),eq(company.tenantId,tenant),eq(company.country,'MY'))).limit(1);
  if(!taxCompany)decline('tax-selection-company');
  await tryAdvisoryLocksTx(tx,rows.map(r=>tenant+r.employmentId+'tax-scheme'));
  const selections=await tx.insert(employmentTaxSelectionMy).values(rows.map(r=>hireGroup!.taxSelectionValues(ctx,{employmentId:r.employmentId,companyId,epoch:0,scheme:r.step.row.initialTaxScheme??'resident'}))).returning();
  const selectionOf=new Map(selections.map(s=>[s.employmentId,s]));
  rows.forEach((r,i)=>{const s=selectionOf.get(r.employmentId);if(!s)decline('tax-selection-insert');
   events[i].push({tenantId:tenant,aggregateType:'employment-tax-selection',aggregateId:s!.id,eventType:'employee.tax-scheme.selected',actor,subjectEmploymentId:r.employmentId,payload:hireGroup!.taxSelectionEventPayload(s!)});});
  // The organisation classification owner, per employment, in one statement.
  const tags=await tx.execute<{tags:unknown}>(sql`select app.record_employment_organisation_tags(e,${companyId}::uuid,d,'hire') as tags from unnest(${uuidList(employmentIds)},${sql`${`{${hires.map(h=>h.hiredOn).join(',')}}`}::date[]`}) with ordinality as u(e,d,n) order by n`);
  if(tags.length!==rows.length||tags.some(t=>!t.tags))decline('organisation-tags');
  // The Import History item names the Employee ID as stored (recordImportItemTx's caller reads it back).
  return rows.map(r=>({step:r.step,personId:r.personId,employmentId:r.employmentId,code:information.get(r.employmentId)?.employeeCode??''}));
 });

 // ── initializeHiredStatutoryMY, for the group ───────────────────────────────────────────────────────────────
 await lockStatutoryGroupTx(tx,ctx,rows.map(r=>({personId:r.personId})));
 const statutoryIds=await tx.insert(employeeStatutoryMy).values(rows.map(r=>({tenantId:tenant,personId:r.personId,...r.statutory.values}))).returning({id:employeeStatutoryMy.id,personId:employeeStatutoryMy.personId});
 const statutoryOf=new Map(statutoryIds.map(s=>[s.personId,s.id]));
 const subjects=await subjectEmploymentsTx(tx,tenant,personIds);
 rows.forEach((r,i)=>{const id=statutoryOf.get(r.personId);if(!id)decline('statutory-insert');
  events[i].push({tenantId:tenant,aggregateType:'employee-statutory-my',aggregateId:id!,eventType:'statutory.my.created',actor,subjectEmploymentId:subjects.get(r.personId)??null,payload:hireGroup!.profileEventPayload(r.personId,r.statutory)});});

 // ── setPersonComplianceFields (the IC-derived date of birth), for the rows that carry one ────────────────────
 const withDob=rows.map((r,i)=>({r,i})).filter(({r})=>r.dob!==null);
 if(withDob.length){
  const dobEmployments=withDob.map(({r})=>r.employmentId),dobPersons=withDob.map(({r})=>r.personId);
  await lockAccessConfigurationTx(tx,tenant);
  await joinWorkforceBarrierTx(tx,tenant);
  await allTrue(tx,sql`select bool_and(app.access_workforce_employment(e,'workforce.maintain')) as ok from unnest(${uuidList(dobEmployments)}) as u(e)`,'compliance-employment');
  await lockEmploymentLeaveDependenciesTx(tx,tenant,[],{configuration:true});
  await allTrue(tx,sql`select bool_and(app.access_workforce_person(p,'workforce.maintain')) as ok from unnest(${uuidList(dobPersons)}) as u(p)`,'compliance-person');
  await lockAccessConfigurationTx(tx,tenant);
  // lockPersonLeaveDependenciesWaitTx: every employment of each person (each new person has exactly this one).
  const peers=await tx.execute<{id:string}>(sql`select peer.id from public.employment subject join public.employment peer on peer.person_id=subject.person_id and peer.tenant_id=subject.tenant_id where subject.id=any(${uuidList(dobEmployments)})`);
  if(peers.length!==dobEmployments.length)decline('compliance-peers');
  await lockLeaveDependenciesWaitTx(tx,tenant,[]);
  await tryAdvisoryLocksTx(tx,dobEmployments.map(id=>`leave-dependency-employment:${tenant.toLowerCase()}:${id.toLowerCase()}`));
  await lockProfileValueSharedTx(tx,tenant);
  await tryAdvisoryLocksTx(tx,dobPersons.map(id=>`profile-subject:${tenant}:${id}`));
  const before=new Map((await tx.select({id:person.id,gender:person.gender,maritalStatus:person.maritalStatus,dateOfBirth:person.dateOfBirth}).from(person).where(inArray(person.id,dobPersons))).map(p=>[p.id,p]));
  for(const {r} of withDob){const b=before.get(r.personId);if(!b||(b.dateOfBirth??'')!=='')decline('compliance-before');}
  await tx.execute(sql`update public.person p set date_of_birth=v.d from unnest(${uuidList(dobPersons)},${sql`${`{${withDob.map(({r})=>r.dob).join(',')}}`}::date[]`}) as v(id,d) where p.id=v.id`);
  for(const {r,i} of withDob){const b=before.get(r.personId)!;
   events[i].push({tenantId:tenant,aggregateType:'person',aggregateId:r.personId,eventType:'person.updated',actor,subjectEmploymentId:r.employmentId,
    payload:adminComplianceEventPayload({dateOfBirth:r.dob},{gender:b.gender,maritalStatus:b.maritalStatus,dateOfBirth:b.dateOfBirth})});}
 }

 // ── setCompensation (the first salary record), for the group ────────────────────────────────────────────────
 await lockAccessConfigurationTx(tx,tenant);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await allTrue(tx,sql`select bool_and(exists(select 1 from public.employment e where e.id=u.id and e.tenant_id=${tenant}::uuid and (app.can_admin_employment(e.id) or app.can_admin_perfcomp_employment(e.id)))) as ok from unnest(${uuidList(employmentIds)}) as u(id)`,'compensation-authority');
 await lockLeaveDependenciesWaitTx(tx,tenant,[]);
 await tryAdvisoryLocksTx(tx,employmentIds.map(id=>`leave-dependency-employment:${tenant.toLowerCase()}:${id.toLowerCase()}`));
 await lockPayrollInputsTx(tx,{employmentIds});
 const current=await tx.select({id:compensation.id}).from(compensation).where(and(inArray(compensation.employmentId,employmentIds),isNull(compensation.validTo),isNull(compensation.supersededAt)));
 if(current.length)decline('compensation-exists');
 const salaries=await tx.insert(compensation).values(rows.map(r=>({tenantId:tenant,...r.terms.values,employmentId:r.employmentId}))).returning({id:compensation.id,employmentId:compensation.employmentId});
 const salaryOf=new Map(salaries.map(s=>[s.employmentId,s.id]));
 rows.forEach((r,i)=>{const id=salaryOf.get(r.employmentId);if(!id)decline('compensation-insert');
  events[i].push({tenantId:tenant,aggregateType:'compensation',aggregateId:id!,eventType:'compensation.set',actor,subjectEmploymentId:r.employmentId,
   payload:compensationSetEventPayload({...r.compensationInput,employmentId:r.employmentId},r.terms.fieldsChanged)});});
 for(const from of new Set(rows.map(r=>r.compensationInput.effectiveFrom))){
  const marked=await markPayrollRunsForCompensationSetTx(tx,ctx,{employmentIds:rows.filter(r=>r.compensationInput.effectiveFrom===from).map(r=>r.employmentId),from});
  if(marked.length)decline('payroll-marked');
 }

 // ── The group's audit events, in the per-row order, in one statement; then the Import History items ─────────
 await appendEvents(tx,events.flat());
 await tx.insert(importAttemptItem).values(written.map(w=>{
  const after:EmployeeFullItemState={employeeCode:w.code,fullName:w.step.row.result.fullName,rowNum:w.step.row.result.rowNum};
  return{tenantId:tenant,attemptId:env.attemptId,companyId:w.step.row.hire.companyId,employmentId:w.employmentId,itemKey:`row:${w.step.row.result.rowNum}`.slice(0,500),label:`${after.employeeCode||'—'} · ${after.fullName}`.slice(0,500),
   ordinal:w.step.index,status:'applied' as const,before:null,after,errors:[]};
 }));
 return written.map(w=>({employmentId:w.employmentId,personId:w.personId,family:0 as const}));
}

/** lockStatutorySourceTx for a group of subjects: the tenant-level interval once (the shared Access lock, the
 * workforce barrier rows, the carrier principal proof, the shared leave configuration lock), the payroll inputs key of
 * every company employing the group, then each subject's lock in one statement. */
async function lockStatutoryGroupTx(tx:Tx,ctx:SessionContext,subjects:readonly {personId:string;employmentId?:string}[]){
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 if(ctx.userId&&!(await isCarrierPrincipalCurrentTx(tx,ctx)))throw new Error('Statutory authority unavailable');
 await lockLeaveDependenciesWaitTx(tx,ctx.tenantId,[]);
 const employmentIds=subjects.map(s=>s.employmentId).filter((id):id is string=>!!id);
 if(employmentIds.length)await lockPayrollInputsTx(tx,{employmentIds});
 else{const rows=await tx.select({id:employment.id}).from(employment).where(inArray(employment.personId,subjects.map(s=>s.personId)));await lockPayrollInputsTx(tx,{employmentIds:rows.map(r=>r.id)});}
 const tenant=ctx.tenantId.toLowerCase();
 await tryAdvisoryLocksTx(tx,subjects.map(s=>`statutory-subject:${tenant}:person:${s.personId.toLowerCase()}`));
}

/** subjectEmploymentForPerson for many people in one statement (same deterministic pick). */
async function subjectEmploymentsTx(tx:Tx,tenantId:string,personIds:readonly string[]){
 const rows=await tx.execute<{person_id:string;id:string}>(sql`select distinct on (person_id) person_id,id from public.employment where tenant_id=${tenantId}::uuid and person_id=any(${uuidList(personIds)})
  order by person_id,(terminated_on is not null),hired_on,id`);
 return new Map(rows.map(r=>[r.person_id,r.id]));
}
