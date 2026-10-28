/** Canonical storage/lifecycle regressions. Source-only until the shared release hold is lifted. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {asc,eq,sql} from 'drizzle-orm';
import {db,withTenant} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
import {lockLeaveDependenciesTx} from '../core/leave-dependency-lock';
import {createCompany} from '../core/admin';
import {readOvertimeStarterSeed,prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
import {activateOvertimePattern,archiveOvertimePattern,ensureOvertimePatternStarters,captureOvertimePersonnelContextTx,createOvertimeCalculationOwner,forkOvertimePatternDraft,getOvertimePattern,listOvertimePatterns,readOvertimeCalculationTx,readOvertimeDurationsTx,listCoveredOvertimeDaysTx,readOvertimePersonnelContextTx,readOvertimeSettlementForDayTx,releaseOvertimeSettlementsForDraftTeardownTx,releaseOvertimeSettlementTx,reserveOvertimeSettlementTx,saveOvertimePatternAssignment,saveOvertimePatternDraft,stopOvertimePatternVersion,validateOvertimePatternActivation,type CanonicalOvertimeSnapshot} from '../packs/attendance/overtime-patterns';
import {requestAttendanceCorrection,decideAttendanceCorrection,saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../packs/attendance/service';
let b:Base,employmentId:string,attendanceId:string,earningId:string;const day=()=>todayInKualaLumpur();
const plus=(n:number)=>{const d=new Date(day()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const yes=(id:string)=>({id,type:'constant' as const,value:true});
function pattern():OvertimePattern{return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:yes('eligible'),eligibleMinutes:{id:'fraction',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Test payment',description:'Fixture policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningId,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:'25'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};}
function draft(definition=pattern()){return {code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Test overtime',description:'Fixture',definition};}
function known<T>(value:T){return {state:'known' as const,value,provenance:{owner:'attendance' as const,reference:attendanceId,asOf:day(),basis:'recorded' as const}};}
function snapshot():CanonicalOvertimeSnapshot{return {resolvedLegacyRuleId:null,referenceDigest:'c'.repeat(64),input:{layer:'raw',sessionGranularity:'recorded',source:{tenantId:b.tenantId,employmentId,attendanceId,date:day(),inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},currency:{code:'MYR',minorScale:2},facts:{companyId:known(b.companyId),employmentId:known(employmentId),dayType:known('workday'),actualWorkingMinutes:known('120'),requiredWorkingMinutes:known('0'),basicSalary:{state:'unknown',reason:'No financial visibility'}},resources:[],approval:{status:'approved',minutes:known('120'),provenance:{owner:'approval',reference:'approved-day',asOf:day(),basis:'recorded'}},segments:[{id:'segment',sessionId:'session',dayType:known('workday'),clock:{state:'unknown',reason:'Not needed for this policy'},rawMinutes:known('120'),approvedMinutes:known('120')}]}};}
async function activated(definition=pattern()){const saved=await saveOvertimePatternDraft(adminCtx(b),{draft:draft(definition)});const check=await validateOvertimePatternActivation(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision});expect(check.issues).toEqual([]);expect(check.validationDigest).not.toBeNull();await activateOvertimePattern(adminCtx(b),{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest!,effectiveFrom:day()});await saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:1,from:day(),to:null});return saved;}
async function recorded(){await activated();const api=createOvertimeCalculationOwner(async()=>snapshot());return withTenant(adminCtx(b),async tx=>{const prepared=await api.prepareTx(tx,adminCtx(b),{employmentId,date:day()});return api.recordTx(tx,adminCtx(b),{prepared,expectedCurrentRevision:0});});}
async function batch(){const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:day().slice(0,7)}).returning();const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:period.period,batchDate:day()}).returning();return batch;}
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'OT Employee',primaryEmail:`ot-owner-${randomUUID()}@example.test`}).returning();const [employee]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,companyId:b.companyId,personId:person.id,hiredOn:plus(-10)}).returning();employmentId=employee.id;await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:plus(-10)});const [attendance]=await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId,attendanceDate:day(),checkInAt:'09:00:00',checkOutAt:'18:00:00',otMinutes:120}).returning();attendanceId=attendance.id;const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'OT',name:'OT fixture',kind:'allowance'}).returning();earningId=earning.id;});
describe('persisted standard starting drafts',()=>{
 it('creates four scoped, unassigned drafts once across concurrent visits, with one actual audit each',async()=>{
  const ctx=adminCtx(b),answers=await Promise.all([ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId]}),ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId,b.companyId]})]);
  expect(answers.map(answer=>answer.created).sort((a,b)=>a-b)).toEqual([0,4]);
  const rows=await listOvertimePatterns(ctx,{companyIds:[b.companyId]});expect(rows.items).toHaveLength(4);
  expect(rows.items.map(row=>readOvertimeStarterSeed(row.latestVersion?.definition)).sort()).toEqual(['ot00','ot15','ot20','ot30']);
  for(const row of rows.items){
   const view=await getOvertimePattern(ctx,row.id);expect(view?.assignments).toEqual([]);
   expect(view?.versions).toHaveLength(1);expect(view!.versions[0]).toMatchObject({status:'draft',activatedAt:null,companyIds:[b.companyId],states:[]});
   const check=await validateOvertimePatternActivation(ctx,{versionId:view!.versions[0].id,expectedRevision:view!.versions[0].revision});
   expect(check.validationDigest).toBeNull();expect(check.issues.some(issue=>issue.severity==='error')).toBe(true);
   const audits=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,row.id)).orderBy(asc(s.domainEvent.id));
   expect(audits).toHaveLength(1);expect(audits[0]).toMatchObject({eventType:'overtime.draft.saved',actorType:'user',actorId:ctx.userId});
  }
 });
 it('retains edited and archived starters and never adopts or renames existing company patterns',async()=>{
  const ctx=adminCtx(b),custom=await saveOvertimePatternDraft(ctx,{draft:{...draft(),name:'OT 1.5'}});
  expect(await ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId]})).toEqual({created:4});
  const rows=(await listOvertimePatterns(ctx,{companyIds:[b.companyId]})).items;
  const seed=rows.find(row=>readOvertimeStarterSeed(row.latestVersion?.definition)==='ot15')!,version=seed.latestVersion!;
  const definition=prepareOvertimeStarter('ot15','session','latest');
  await saveOvertimePatternDraft(ctx,{patternId:seed.id,versionId:version.id,expectedRevision:version.revision,draft:{code:seed.code!,creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Edited company rate',definition}});
  const zero=rows.find(row=>readOvertimeStarterSeed(row.latestVersion?.definition)==='ot00')!;
  await archiveOvertimePattern(ctx,{patternId:zero.id,expectedRevision:zero.revision,reason:'Fictional deliberate archive'});
  const before=await getOvertimePattern(ctx,seed.id),archived=await getOvertimePattern(ctx,zero.id),customBefore=await getOvertimePattern(ctx,custom.patternId);
  expect(await ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId]})).toEqual({created:0});
  expect(await getOvertimePattern(ctx,seed.id)).toEqual(before);expect(await getOvertimePattern(ctx,zero.id)).toEqual(archived);
  expect(await getOvertimePattern(ctx,custom.patternId)).toEqual(customBefore);
  expect((await listOvertimePatterns(ctx,{companyIds:[b.companyId]})).items).toHaveLength(5);
 });
 it('refuses a foreign company and disabled Attendance before creating any starting draft',async()=>{
  const ctx=adminCtx(b),foreign=await seedBase();
  await expect(ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId,foreign.companyId]})).rejects.toMatchObject({code:'permission'});
  expect((await listOvertimePatterns(ctx)).items).toHaveLength(0);
  await setModule(b.tenantId,'attendance','disabled');
  // A fresh entitlement context is required: the module owner never accepts a caller's enabled flag.
  await expect(ensureOvertimePatternStarters(await entitledCtx(b),{companyIds:[b.companyId]})).rejects.toThrow();
  expect(await owner.db.select({id:s.overtimePattern.id}).from(s.overtimePattern).where(eq(s.overtimePattern.tenantId,b.tenantId))).toEqual([]);
 });
 it('refuses an occupied starting code without adopting it or leaving the other three partial drafts',async()=>{
  const ctx=adminCtx(b),custom=await saveOvertimePatternDraft(ctx,{draft:{...draft(),code:`STD_OT15_${b.companyId}`,name:'Human-owned collision'}});
  const before=await getOvertimePattern(ctx,custom.patternId);
  const audits=await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.id));
  await expect(ensureOvertimePatternStarters(ctx,{companyIds:[b.companyId]})).rejects.toMatchObject({code:'conflict'});
  expect(await getOvertimePattern(ctx,custom.patternId)).toEqual(before);
  expect((await listOvertimePatterns(ctx)).items.map(row=>row.id)).toEqual([custom.patternId]);
  expect(await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.id))).toEqual(audits);
 });
 it('uses current administrator scope, keeps other companies separate, and refuses a forged role or mixed scope atomically',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Other fictional starter employer',country:'MY',currency:'MYR'});
  const [subject]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));
  const userId=await createAppUser(b.tenantId,subject.personId,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped={...ctx,userId,personId:subject.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  await expect(ensureOvertimePatternStarters(scoped,{companyIds:[b.companyId,other.id]})).rejects.toMatchObject({code:'permission'});
  expect((await listOvertimePatterns(ctx)).items).toHaveLength(0);
  expect(await ensureOvertimePatternStarters(scoped,{companyIds:[b.companyId]})).toEqual({created:4});
  expect((await listOvertimePatterns(ctx,{companyIds:[other.id]})).items).toHaveLength(0);
  expect(await ensureOvertimePatternStarters(ctx,{companyIds:[other.id]})).toEqual({created:4});
  const first=(await listOvertimePatterns(ctx,{companyIds:[b.companyId]})).items,second=(await listOvertimePatterns(ctx,{companyIds:[other.id]})).items;
  expect(new Set([...first,...second].map(row=>row.id)).size).toBe(8);
  await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,userId));
  await expect(ensureOvertimePatternStarters({...scoped,roles:['hr_admin']},{companyIds:[b.companyId]})).rejects.toThrow();
  expect((await listOvertimePatterns(ctx)).items).toHaveLength(8);
 });
});
describe('company-filtered Overtime Pattern listing',()=>{
 async function listFixture(){
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Other OT listing company',country:'MY',currency:'MYR'}),empty=await createCompany(ctx,{legalName:'Empty OT listing company',country:'MY',currency:'MYR'}),prefix='LIST_'+randomUUID().slice(0,8);
  const save=(suffix:string,creationCompanyId:string,companyIds:string[])=>saveOvertimePatternDraft(ctx,{draft:{...draft(),code:prefix+'_'+suffix,name:prefix+' '+suffix,creationCompanyId,companyIds}});
  const first=await save('FIRST',b.companyId,[b.companyId]),second=await save('SECOND',other.id,[other.id]),shared=await save('SHARED',b.companyId,[b.companyId,other.id]);
  return {ctx,other,empty,prefix,first,second,shared};
 }
 it('binds one and multiple selected companies in both list and matching-version queries',async()=>{
  const f=await listFixture();
  for(const [companyIds,expected]of [[[b.companyId],[f.first.patternId,f.shared.patternId]],[[f.other.id],[f.second.patternId,f.shared.patternId]],[[b.companyId,f.other.id],[f.first.patternId,f.second.patternId,f.shared.patternId]]] as const){
   const rows=await listOvertimePatterns(f.ctx,{companyIds:[...companyIds],search:f.prefix,status:'draft',method:'flat'});
   expect(rows.items.map(row=>row.id).sort()).toEqual([...expected].sort());expect(rows.nextCursor).toBeNull();
   for(const row of rows.items){expect(row.matchingVersion).not.toBeNull();expect(row.matchingVersion!.companyIds.some(id=>companyIds.some(selected=>selected===id))).toBe(true);}
  }
  const page=await listOvertimePatterns(f.ctx,{companyIds:[b.companyId,f.other.id],search:f.prefix,limit:1});expect(page.items).toHaveLength(1);expect(page.nextCursor).toBe(page.items[0].id);
  const next=await listOvertimePatterns(f.ctx,{companyIds:[b.companyId,f.other.id],search:f.prefix,cursor:page.nextCursor!,limit:1});expect(next.items).toHaveLength(1);expect(next.items[0].id).not.toBe(page.items[0].id);
 });
 it('keeps omitted scope, an explicit empty selection and a company with no matches distinct',async()=>{
  const f=await listFixture();
  expect((await listOvertimePatterns(f.ctx,{search:f.prefix})).items.map(row=>row.id).sort()).toEqual([f.first.patternId,f.second.patternId,f.shared.patternId].sort());
  await expect(listOvertimePatterns(f.ctx,{companyIds:[],search:f.prefix})).rejects.toMatchObject({code:'invalid'});
  expect(await listOvertimePatterns(f.ctx,{companyIds:[f.empty.id],search:f.prefix})).toEqual({items:[],nextCursor:null});
 });
 it('returns only visible company patterns and refuses a wrong-company filter under the real app role',async()=>{
  const f=await listFixture(),[employee]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,employmentId));
  const userId=await createAppUser(b.tenantId,employee.personId,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const scoped={...adminCtx(b),userId,personId:employee.personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
  for(const companyIds of [undefined,[b.companyId]]){
   const rows=await listOvertimePatterns(scoped,{companyIds,search:f.prefix});expect(rows.items.map(row=>row.id).sort()).toEqual([f.first.patternId,f.shared.patternId].sort());
   expect(rows.items.find(row=>row.id===f.first.patternId)!.writable).toBe(true);expect(rows.items.find(row=>row.id===f.shared.patternId)!.writable).toBe(false);
  }
  expect(await getOvertimePattern(scoped,f.second.patternId)).toBeNull();
  for(const companyIds of [[f.other.id],[b.companyId,f.other.id]])await expect(listOvertimePatterns(scoped,{companyIds,search:f.prefix})).rejects.toMatchObject({code:'permission'});
 });
});
describe('manual samples retain hypothetical eligibility without source authority',()=>{
 const zero='00000000-0000-0000-0000-000000000000';
 async function savedSample(eligibility:OvertimePattern['eligibility']){const definition=pattern();definition.eligibility=eligibility;definition.eligibleMinutes={id:'sample_shortfall',type:'subtract',unit:'minutes',left:{id:'sample_actual',type:'field',unit:'minutes',field:'actualWorkingMinutes'},right:{id:'sample_required',type:'field',unit:'minutes',field:'requiredWorkingMinutes'}};return saveOvertimePatternDraft(adminCtx(b),{draft:draft(definition)});}
 function hypothetical(){const input={...snapshot().input,mode:'actual' as const,patternVersionId:randomUUID(),assignmentId:randomUUID()};input.source={...input.source,tenantId:randomUUID(),employmentId:randomUUID(),attendanceId:randomUUID()};if(input.layer!=='raw')throw new Error('Expected raw sample fixture');input.facts.actualWorkingMinutes=known('541');input.facts.requiredWorkingMinutes=known('480');input.approval.minutes=known('61');input.segments[0].rawMinutes=known('541');input.segments[0].approvedMinutes=known('541');return input;}
 async function unchangedFacts(){return {source:await owner.db.select().from(s.attendanceOvertimeSource).orderBy(asc(s.attendanceOvertimeSource.id)),calculations:await owner.db.select().from(s.attendanceOvertimeCalculation).orderBy(asc(s.attendanceOvertimeCalculation.id)),claims:await owner.db.select().from(s.overtimeSourceSettlement).orderBy(asc(s.overtimeSourceSettlement.id)),events:await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.sequence)),attendance:await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId))};}
 it('evaluates selected employee/company facts and ignores caller-supplied source authority without writes',async()=>{
  const saved=await savedSample({id:'sample_scope',type:'group',logic:'and',children:[{id:'sample_employee',type:'selection',field:'employmentId',operator:'in',values:[employmentId]},{id:'sample_company',type:'selection',field:'companyId',operator:'in',values:[b.companyId]}]}),api=createOvertimeCalculationOwner(async()=>{throw new Error('Manual samples must not read canonical employee facts');}),before=await unchangedFacts();
  const sample=hypothetical(),result=await api.previewSample(adminCtx(b),{...saved,sample});expect(result.status).toBe('ready');if(result.status==='refused')throw new Error('Expected selected sample eligibility');expect(result.payableMinutes).toMatchObject({numerator:'61',denominator:'1'});expect(result.transferable).toBe(false);expect(result.source).toMatchObject({tenantId:b.tenantId,employmentId:zero,attendanceId:zero});expect(result.patternVersionId).toBe(saved.versionId);expect(result.assignmentId).toBe(zero);
  for(const field of ['employmentId','companyId'] as const){const changed=structuredClone(sample);changed.facts[field]=known(randomUUID());const negative=await api.previewSample(adminCtx(b),{...saved,sample:changed});expect(negative.status).toBe('ineligible');expect(negative.transferable).toBe(false);}
  expect(await unchangedFacts()).toEqual(before);
 });
 it('distinguishes known-missing null, Unknown and absent employee facts without forcing a synthetic employee value',async()=>{
  const missing=await savedSample({id:'missing_employee',type:'null',field:'employmentId',isNull:true}),constant=await savedSample(yes('unconditional')),api=createOvertimeCalculationOwner(async()=>{throw new Error('No current Personnel fallback');}),before=await unchangedFacts();
  for(const kind of ['null','unknown','absent'] as const){const sample=hypothetical();if(kind==='null')sample.facts.employmentId=known(null);else if(kind==='unknown')sample.facts.employmentId={state:'unknown',reason:'sample_not_entered'};else delete sample.facts.employmentId;
   const dependent=await api.previewSample(adminCtx(b),{...missing,sample});expect(dependent.transferable).toBe(false);
   if(kind==='null')expect(dependent.status).toBe('ready');else{expect(dependent.status).toBe('refused');if(dependent.status!=='refused')throw new Error('Expected Unknown employee eligibility');expect(dependent.issues.some(issue=>issue.code==='unknown'&&issue.path==='employmentId')).toBe(true);}
   const independent=await api.previewSample(adminCtx(b),{...constant,sample});expect(independent.status).toBe('ready');expect(independent.transferable).toBe(false);
  }
  expect(await unchangedFacts()).toEqual(before);
 });
 it('retains real workspace/version authorization before evaluating any hypothetical facts',async()=>{
  const saved=await savedSample(yes('eligible')),api=createOvertimeCalculationOwner(async()=>{throw new Error('No canonical reader');}),sample=hypothetical();
  await expect(api.previewSample(adminCtx(b),{...saved,patternId:randomUUID(),sample})).rejects.toMatchObject({code:'invalid'});
  const [employee]=await owner.db.select({personId:s.employment.personId}).from(s.employment).where(eq(s.employment.id,employmentId)),userId=await createAppUser(b.tenantId,employee.personId,'employee');
  await expect(api.previewSample({...adminCtx(b),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},{...saved,sample})).rejects.toMatchObject({code:'permission'});
 });
});
describe('Draft, activation and effective assignment',()=>{
 it('saves and reopens structurally complete unfinished decimal controls, while activation refuses',async()=>{const def=pattern();def.rates[0].tiers[0].payment={method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:''}};const saved=await saveOvertimePatternDraft(adminCtx(b),{draft:draft(def)});const read=await getOvertimePattern(adminCtx(b),saved.patternId);expect(read!.versions[0].definition).toEqual(def);expect((await validateOvertimePatternActivation(adminCtx(b),{versionId:saved.versionId,expectedRevision:1})).validationDigest).toBeNull();});
 it('rejects malformed drafts instead of promising editor-safe typed arrays',async()=>{for(const malformed of [{},{...pattern(),rates:null}])await expect(saveOvertimePatternDraft(adminCtx(b),{draft:draft(malformed as OvertimePattern)})).rejects.toThrow();});
 it('makes activated definitions immutable and forks a distinct editable revision',async()=>{const saved=await activated();await expect(withTenant(adminCtx(b),tx=>tx.update(s.overtimePatternVersion).set({name:'Overwrite'}).where(eq(s.overtimePatternVersion.id,saved.versionId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/i)})});const detail=await getOvertimePattern(adminCtx(b),saved.patternId);const fork=await forkOvertimePatternDraft(adminCtx(b),{versionId:saved.versionId,expectedPatternRevision:detail!.pattern.revision});expect(fork.versionId).not.toBe(saved.versionId);expect((await getOvertimePattern(adminCtx(b),saved.patternId))!.versions.map(v=>v.status)).toEqual(['draft','active']);});
 it('refuses stale activation after the earning reference changes',async()=>{const saved=await saveOvertimePatternDraft(adminCtx(b),{draft:draft()});const check=await validateOvertimePatternActivation(adminCtx(b),{versionId:saved.versionId,expectedRevision:1});await owner.db.update(s.payComponent).set({name:'Changed mapping'}).where(eq(s.payComponent.id,earningId));await expect(activateOvertimePattern(adminCtx(b),{versionId:saved.versionId,expectedRevision:1,validationDigest:check.validationDigest!,effectiveFrom:day()})).rejects.toMatchObject({code:'stale'});});
 it('refuses equal-priority overlapping individual assignments, but permits explicit greater priority',async()=>{const saved=await activated();await expect(saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:1,from:day(),to:null})).rejects.toMatchObject({code:'conflict'});await expect(saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:2,from:day(),to:null})).resolves.toHaveProperty('assignmentId');});
 it('returns the matching activated version when a newer Draft has another payment method',async()=>{const saved=await activated(),detail=await getOvertimePattern(adminCtx(b),saved.patternId);await forkOvertimePatternDraft(adminCtx(b),{versionId:saved.versionId,expectedPatternRevision:detail!.pattern.revision});const rows=await listOvertimePatterns(adminCtx(b),{status:'active',method:'flat'});const found=rows.items.find(item=>item.id===saved.patternId)!;expect(found.latestVersion!.status).toBe('draft');expect(found.matchingVersion!.id).toBe(saved.versionId);});
 it('appends a same-day stop without mutating the activated version',async()=>{const saved=await activated(),before=await getOvertimePattern(adminCtx(b),saved.patternId);await stopOvertimePatternVersion(adminCtx(b),{versionId:saved.versionId,expectedRevision:before!.versions[0].revision,effectiveFrom:day(),reason:'Prospective policy stop'});const after=await getOvertimePattern(adminCtx(b),saved.patternId);expect(after!.versions[0].states.map(st=>st.state)).toEqual(['active','inactive']);expect(after!.versions[0].definition).toEqual(before!.versions[0].definition);});
});
describe('Canonical source and immutable exact evidence',()=>{
 it('captures current Personnel once and never substitutes a later profile edit',async()=>{await withTenant(adminCtx(b),tx=>captureOvertimePersonnelContextTx(tx,adminCtx(b),{employmentId,date:day(),facts:{orgTeam:known(null)}}));await owner.db.update(s.employment).set({orgTeam:'Changed later'}).where(eq(s.employment.id,employmentId));const saved=await withTenant(adminCtx(b),tx=>captureOvertimePersonnelContextTx(tx,adminCtx(b),{employmentId,date:day(),facts:{orgTeam:known('Changed later')}}));expect(saved.facts.orgTeam).toMatchObject({state:'known',value:null});await expect(withTenant(adminCtx(b),tx=>captureOvertimePersonnelContextTx(tx,adminCtx(b),{employmentId,date:plus(-1),facts:{}}))).rejects.toThrow();});
 it('rejects forged opaque handles before reading or writing a calculation',async()=>{const api=createOvertimeCalculationOwner(async()=>snapshot());await expect(withTenant(adminCtx(b),tx=>api.recordTx(tx,adminCtx(b),{prepared:{} as never,expectedCurrentRevision:0}))).rejects.toMatchObject({code:'permission'});});
 it('refuses changed canonical input between prepare and record in the same transaction',async()=>{await activated();let snap=snapshot();const api=createOvertimeCalculationOwner(async()=>snap);await expect(withTenant(adminCtx(b),async tx=>{const prepared=await api.prepareTx(tx,adminCtx(b),{employmentId,date:day()});snap={...snap,referenceDigest:'d'.repeat(64)};return api.recordTx(tx,adminCtx(b),{prepared,expectedCurrentRevision:0});})).rejects.toMatchObject({code:'stale'});});
 it('rolls back unexpected reference-read faults instead of saving private database text as a refusal',async()=>{
  await activated();const ctx=adminCtx(b),fault=new Error('PRIVATE SQL reference connection failure');
  const api=createOvertimeCalculationOwner(async()=>snapshot());
  await expect(withTenant(ctx,async tx=>{
   const failingTx=new Proxy(tx,{get(target,key){
    if(key==='select')return (...args:Parameters<typeof tx.select>)=>{
     const query=target.select(...args),from=query.from.bind(query);
     query.from=((table:Parameters<typeof query.from>[0])=>{if(table===s.payComponent)throw fault;return from(table);}) as typeof query.from;
     return query;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }});
   const prepared=await api.prepareTx(failingTx,ctx,{employmentId,date:day()});
   return api.recordTx(failingTx,ctx,{prepared,expectedCurrentRevision:0});
  })).rejects.toBe(fault);
  expect(await owner.db.select().from(s.attendanceOvertimeCalculation)).toHaveLength(0);
  expect(await owner.db.select().from(s.attendanceOvertimeCalculationEvidence)).toHaveLength(0);
 });
 it('records exact fractional duration without fabricating legacy integer buckets',async()=>{const result=await recorded();expect(result.status).toBe('recorded');const rows=await withTenant(adminCtx(b),tx=>readOvertimeDurationsTx(tx,adminCtx(b),{entries:[{employmentId,date:day()}]}));expect(rows[0].payableExact).toEqual({unit:'minutes',numerator:'121',denominator:'2'});expect(rows[0].durationStatus).toBe('ready');expect((await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId)))[0].otMinutes).toBe(120);});
 it('keeps recorded duration/evidence accessible to its financial owner after Attendance is disabled',async()=>{await recorded();await setModule(b.tenantId,'attendance','disabled');const ctx=adminCtx(b);await expect(withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId,date:day()}))).resolves.toHaveProperty('calculation');await expect(withTenant(ctx,tx=>readOvertimePersonnelContextTx(tx,ctx,{employmentId,date:day()}))).resolves.toBeNull();});
});
describe('Retained settlement lifecycle and DDL authority',()=>{
 it('blocks closed-batch raw writes without reopening the immutable run',async()=>{const result=await recorded();if(result.status!=='recorded')throw new Error('Fixture formula missing');const run=await batch();await withTenant(adminCtx(b),tx=>reserveOvertimeSettlementTx(tx,adminCtx(b),{employmentId,date:day(),mode:'cash',calculationId:result.calculationId,payrollBatchId:run.id}));await owner.db.update(s.payrollBatch).set({status:'closed'}).where(eq(s.payrollBatch.id,run.id));await expect(withTenant(adminCtx(b),tx=>tx.update(s.attendance).set({workedMinutes:999}).where(eq(s.attendance.id,attendanceId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/closed/i)})});});
 it('retains released batch identity on a separate draft teardown',async()=>{const result=await recorded();if(result.status!=='recorded')throw new Error('Fixture formula missing');const run=await batch();await withTenant(adminCtx(b),tx=>reserveOvertimeSettlementTx(tx,adminCtx(b),{employmentId,date:day(),mode:'cash',calculationId:result.calculationId,payrollBatchId:run.id}));await withTenant(adminCtx(b),async tx=>{await releaseOvertimeSettlementsForDraftTeardownTx(tx,adminCtx(b),{batchId:run.id,reason:'Canonical draft teardown'});await tx.delete(s.payrollBatch).where(eq(s.payrollBatch.id,run.id));});const [history]=await owner.db.select().from(s.overtimeSourceSettlement);expect(history.payrollBatchId).toBeNull();expect(history.ownerReference).toEqual({type:'payroll_batch',id:run.id});expect(history.releasedAt).not.toBeNull();});
 it('does not create a source for a declared-only legacy TOIL day',async()=>{const result=await withTenant(adminCtx(b),tx=>readOvertimeSettlementForDayTx(tx,adminCtx(b),{employmentId,date:plus(1)}));expect(result).toBeNull();expect(await owner.db.select().from(s.attendanceOvertimeSource)).toHaveLength(0);});
 it('forces RLS and does not grant app TRUNCATE or public SECURITY DEFINER execution',async()=>{const tables=await owner.db.execute(sql`select relname,relrowsecurity,relforcerowsecurity,has_table_privilege('ai_hr_app',oid,'TRUNCATE') as trunc from pg_class where relname in ('attendance_overtime_source','attendance_overtime_calculation','overtime_source_settlement','overtime_pattern_version')`) as unknown as {relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean;trunc:boolean}[];expect(tables).toHaveLength(4);for(const table of tables)expect(table).toMatchObject({relrowsecurity:true,relforcerowsecurity:true,trunc:false});const [role]=await withTenant(adminCtx(b),tx=>tx.execute(sql`select rolbypassrls,rolsuper from pg_roles where rolname=current_user`)) as unknown as {rolbypassrls:boolean;rolsuper:boolean}[];expect(role).toMatchObject({rolbypassrls:false,rolsuper:false});});
 it('refuses another tenant employee in the assignment owner even with a valid UUID',async()=>{const other=await seedBase();const [person]=await owner.db.insert(s.person).values({tenantId:other.tenantId,fullName:'Other tenant',primaryEmail:`ot-foreign-${randomUUID()}@example.test`}).returning();const [employee]=await owner.db.insert(s.employment).values({tenantId:other.tenantId,companyId:other.companyId,personId:person.id,hiredOn:day()}).returning();const saved=await activated();await expect(saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[employee.id]},priority:2,from:day(),to:null})).rejects.toThrow();});
});

describe('Serialization and legacy owner continuity',()=>{
 it('refuses an overtime configuration save as busy while a leave-dependency command holds the leave lock, saving nothing',async()=>{
  const ctx=adminCtx(b);let holding!:()=>void,release!:()=>void;const held=new Promise<void>(resolve=>holding=resolve),done=new Promise<void>(resolve=>release=resolve);
  const leave=withTenant(ctx,async tx=>{await lockLeaveDependenciesTx(tx,ctx.tenantId,[employmentId]);holding();await done;});
  await held;
  const before=(await owner.db.select().from(s.overtimePattern)).length;
  try{await expect(saveOvertimePatternDraft(ctx,{draft:draft()})).rejects.toMatchObject({name:'OvertimeOwnerError',code:'busy'});}
  finally{release();await leave;}
  expect(await owner.db.select().from(s.overtimePattern)).toHaveLength(before);
  await expect(saveOvertimePatternDraft(ctx,{draft:draft()})).resolves.toMatchObject({versionId:expect.any(String)});
 });
 it('serializes competing READ COMMITTED equal-priority assignment saves',async()=>{const saved=await activated();const results=await Promise.allSettled([1,2].map(()=>saveOvertimePatternAssignment(adminCtx(b),{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:2,from:day(),to:null})));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);});
 it('forces a pinned REPEATABLE READ configuration writer to restart after another edit',async()=>{await activated();let signalPinned!:()=>void,releasePinned!:()=>void;const pinned=new Promise<void>(resolve=>signalPinned=resolve),changed=new Promise<void>(resolve=>releasePinned=resolve);const ctx=adminCtx(b);
  const stale=db.transaction(async tx=>{await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`);await tx.select().from(s.overtimePatternEpoch);signalPinned();await changed;await tx.execute(sql`select app.lock_overtime_configuration(${b.tenantId}::uuid)`);},{isolationLevel:'repeatable read'});
  // Observe the failure immediately as a settled promise, avoiding an unhandled rejection.
  const outcome=stale.then(()=>({ok:true,error:null}),error=>({ok:false,error}));await pinned;try{await saveOvertimePatternDraft(ctx,{draft:draft()});}finally{releasePinned();}const result=await outcome;expect(result.ok).toBe(false);expect(String((result.error as {cause?:unknown})?.cause??result.error)).toMatch(/serializ|concurrent update/i);
 });
 it('snapshots only the final changed legacy OT ladder and retains deleted unused-group history',async()=>{const ctx=adminCtx(b);const [rule]=await withTenant(ctx,tx=>tx.insert(s.attendanceRule).values({tenantId:b.tenantId,name:'Legacy fixture'}).returning());const versions=async()=>owner.db.select().from(s.overtimePatternVersion).innerJoin(s.overtimePattern,eq(s.overtimePattern.id,s.overtimePatternVersion.patternId)).where(eq(s.overtimePattern.legacyRuleRef,rule.id));expect(await versions()).toHaveLength(1);
  await withTenant(ctx,tx=>tx.update(s.attendanceRule).set({lateGracePeriodMinutes:5}).where(eq(s.attendanceRule.id,rule.id)));expect(await versions()).toHaveLength(1);
  await withTenant(ctx,async tx=>{const [row]=await tx.insert(s.attendanceRuleOtRow).values({tenantId:b.tenantId,ruleId:rule.id,rate:'1.50'}).returning();await tx.update(s.attendanceRuleOtRow).set({rate:'2.00'}).where(eq(s.attendanceRuleOtRow.id,row.id));});expect(await versions()).toHaveLength(2);
  await withTenant(ctx,tx=>tx.delete(s.attendanceRule).where(eq(s.attendanceRule.id,rule.id)));const [retained]=await owner.db.select().from(s.overtimePattern).where(eq(s.overtimePattern.legacyRuleRef,rule.id));expect(retained.legacyRuleId).toBeNull();expect(retained.legacyRuleRef).toBe(rule.id);expect(await versions()).toHaveLength(2);const bindings=await owner.db.select().from(s.overtimePatternLegacyBinding).where(eq(s.overtimePatternLegacyBinding.legacyRuleRef,rule.id));expect(bindings).toHaveLength(2);expect(bindings.every(binding=>binding.ruleId===null)).toBe(true);
 });
 it('retains duration when cash pricing needs an inaccessible salary field',async()=>{const def=pattern();def.rates[0].tiers[0].payment={method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'salary',type:'field',unit:'money',field:'basicSalary'}};await activated(def);const api=createOvertimeCalculationOwner(async()=>snapshot());const result=await withTenant(adminCtx(b),async tx=>{const prepared=await api.prepareTx(tx,adminCtx(b),{employmentId,date:day()});return api.recordTx(tx,adminCtx(b),{prepared,expectedCurrentRevision:0});});if(result.status!=='recorded')throw new Error('Expected formula');expect(result.evaluation!.status).toBe('refused');expect(result.duration!.status).toBe('ready');const durations=await withTenant(adminCtx(b),tx=>readOvertimeDurationsTx(tx,adminCtx(b),{entries:[{employmentId,date:day()}]}));expect(durations[0]).toMatchObject({status:'refused',durationStatus:'ready',payableExact:{numerator:'121',denominator:'2'}});
 });
});

describe('Cash and TOIL source exclusivity',()=>{
 async function accrual(){const [row]=await owner.db.insert(s.toilAccrual).values({tenantId:b.tenantId,employmentId,workedDate:day(),otMinutes:120,daysCredited:'0.25',accrualBasis:'hours_worked',expiresOn:plus(30)}).returning();return row;}
 it('blocks TOIL after cash and treats an identical cash retry as the same claim',async()=>{const result=await recorded();if(result.status!=='recorded')throw new Error('Expected calculation');const run=await batch(),ctx=adminCtx(b),p={employmentId,date:day(),mode:'cash' as const,calculationId:result.calculationId,payrollBatchId:run.id};const first=await withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,p));const retry=await withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,p));expect(retry.id).toBe(first.id);await setModule(b.tenantId,'toil','active');const credit=await accrual();await expect(withTenant(adminCtx(b),tx=>reserveOvertimeSettlementTx(tx,adminCtx(b),{employmentId,date:day(),mode:'toil',toilAccrualId:credit.id}))).rejects.toMatchObject({code:'conflict'});});
 it('blocks cash/raw mutation after TOIL, then permits canonical reversal/release even after module removal',async()=>{const result=await recorded();if(result.status!=='recorded')throw new Error('Expected calculation');await setModule(b.tenantId,'toil','active');const credit=await accrual(),ctx=adminCtx(b);const claim=await withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,{employmentId,date:day(),mode:'toil',toilAccrualId:credit.id}));const run=await batch();await expect(withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,{employmentId,date:day(),mode:'cash',calculationId:result.calculationId,payrollBatchId:run.id}))).rejects.toMatchObject({code:'conflict'});await expect(withTenant(ctx,tx=>tx.update(s.attendance).set({workedMinutes:999}).where(eq(s.attendance.id,attendanceId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/TOIL/i)})});await owner.db.update(s.toilAccrual).set({status:'reversed',reversedAt:new Date(),reversalReason:'Fixture canonical reversal'}).where(eq(s.toilAccrual.id,credit.id));await setModule(b.tenantId,'attendance','disabled');await setModule(b.tenantId,'toil','disabled');await withTenant(adminCtx(b),tx=>releaseOvertimeSettlementTx(tx,adminCtx(b),{settlementId:claim.id,expectedRevision:claim.revision,reason:'Canonical TOIL reversal'}));expect((await withTenant(adminCtx(b),tx=>readOvertimeSettlementForDayTx(tx,adminCtx(b),{employmentId,date:day()})))!.settlement).toBeNull();});
 it('covers explicit sourceUnavailable markers without fabricating a company or source identity',async()=>{await owner.db.update(s.attendance).set({calcTrace:{overtimePattern:{status:'refused',reason:'sourceUnavailable'}} as never}).where(eq(s.attendance.id,attendanceId));await setModule(b.tenantId,'attendance','disabled');const rows=await withTenant(adminCtx(b),tx=>listCoveredOvertimeDaysTx(tx,adminCtx(b),{employmentIds:[employmentId],from:day(),to:day()}));expect(rows).toEqual([{coverage:'sourceUnavailable',employmentId,date:day(),sourceId:null,companyId:null,calculationId:null,versionId:null,outcome:'refused',inputDigest:null,approvalDigest:null,referenceDigest:null}]);});
});

describe('Referenced Attendance identity cannot retarget',()=>{
 async function appIdentityUpdate(setSql:ReturnType<typeof sql>){return withTenant(adminCtx(b),async tx=>{const [principal]=await tx.execute(sql`select current_user as role`) as unknown as {role:string}[];expect(principal.role).toBe('ai_hr_app');return tx.execute(sql`update attendance set ${setSql} where id=${attendanceId}::uuid returning id`);});}
 it('rejects ID, employment, date and tenant retargeting through actual app-role SQL with the identity guard',async()=>{await recorded();const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Other visible same-company employee',primaryEmail:`ot-peer-${randomUUID()}@example.test`}).returning();const [otherEmployment]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,companyId:b.companyId,personId:person.id,hiredOn:plus(-10)}).returning();const otherTenant=await seedBase();
  // Same-company employment and unused date/ID would pass relevant RLS/uniqueness checks. Requiring
  // this exact check violation distinguishes the owner guard from FK/RLS-only accidental refusal.
  for(const change of [sql`id=${randomUUID()}::uuid`,sql`employment_id=${otherEmployment.id}::uuid`,sql`attendance_date=${plus(1)}::date`,sql`tenant_id=${otherTenant.tenantId}::uuid`])await expect(appIdentityUpdate(change)).rejects.toMatchObject({cause:expect.objectContaining({code:'23514',message:expect.stringContaining('Referenced overtime Attendance identity is immutable')})});
  const [dayRow]=await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId));const [source]=await owner.db.select().from(s.attendanceOvertimeSource).where(eq(s.attendanceOvertimeSource.attendanceId,attendanceId));expect(dayRow).toMatchObject({id:attendanceId,tenantId:b.tenantId,employmentId,attendanceDate:day()});expect(source).toMatchObject({attendanceId,tenantId:b.tenantId,employmentId,attendanceDate:day()});
 });
 it('protects context-only source identity and permits an unchanged identity/ordinary metadata update',async()=>{await withTenant(adminCtx(b),tx=>captureOvertimePersonnelContextTx(tx,adminCtx(b),{employmentId,date:day(),facts:{}}));await expect(appIdentityUpdate(sql`attendance_date=${plus(1)}::date`)).rejects.toMatchObject({cause:expect.objectContaining({code:'23514',message:expect.stringContaining('Referenced overtime Attendance identity is immutable')})});await expect(appIdentityUpdate(sql`id=id,tenant_id=tenant_id,employment_id=employment_id,attendance_date=attendance_date,remarks='Ordinary metadata update'`)).resolves.toHaveLength(1);expect((await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId)))[0].remarks).toBe('Ordinary metadata update');});
 it('does not add a blanket identity rule to an unreferenced legacy Attendance day',async()=>{await expect(appIdentityUpdate(sql`attendance_date=${plus(1)}::date`)).resolves.toHaveLength(1);expect(await owner.db.select().from(s.attendanceOvertimeSource)).toHaveLength(0);});
});


describe('raw input guard proves source absence',()=>{
 it('permits a no-context legacy owner write only with effective full visibility and no source',async()=>{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`select set_config('app.tenant_id','',true),set_config('app.user_id','',true)`);
   const [visibility]=await tx.execute(sql`select r.rolsuper or r.rolbypassrls as full from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='app.guard_overtime_cash_source_write()'::regprocedure`) as unknown as {full:boolean}[];expect(visibility.full).toBe(true);
   expect(await tx.update(s.attendance).set({workedMinutes:481}).where(eq(s.attendance.id,attendanceId)).returning()).toHaveLength(1);
  });
 });
 it('preserves ordinary app-context legacy writes without any overtime source',async()=>{
  await expect(withTenant(adminCtx(b),tx=>tx.update(s.attendance).set({workedMinutes:482}).where(eq(s.attendance.id,attendanceId)).returning())).resolves.toHaveLength(1);
  expect(await owner.db.select().from(s.attendanceOvertimeSource)).toHaveLength(0);
 });
 it('does not let a full-visibility no-context owner bypass an actual cash-protected source',async()=>{
  const result=await recorded();if(result.status!=='recorded')throw new Error('Expected formula');const ctx=adminCtx(b),run=await batch();
  await withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,{employmentId,date:day(),mode:'cash',calculationId:result.calculationId,payrollBatchId:run.id}));
  await expect(owner.db.transaction(async tx=>{await tx.execute(sql`select set_config('app.tenant_id','',true),set_config('app.user_id','',true)`);await tx.update(s.attendance).set({workedMinutes:999}).where(eq(s.attendance.id,attendanceId));})).rejects.toMatchObject({cause:expect.objectContaining({code:'42501',message:'Overtime input tenant mismatch'})});
  expect((await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId)))[0].workedMinutes).not.toBe(999);
 });
});


describe('only actual formula inputs are protected by a TOIL claim',()=>{
 it('allows a non-OT pending/rejected workflow, but blocks clock application and OT-bearing input',async()=>{
  await recorded();await setModule(b.tenantId,'toil','active');const ctx=adminCtx(b);
  const [credit]=await owner.db.insert(s.toilAccrual).values({tenantId:b.tenantId,employmentId,workedDate:day(),otMinutes:120,daysCredited:'0.25',accrualBasis:'hours_worked',expiresOn:plus(30)}).returning();
  await withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,{employmentId,date:day(),mode:'toil',toilAccrualId:credit.id}));
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,code:'CLOCK_TOIL',name:'Non-OT correction review',description:'Fictional',applicationType:'irregularity',priority:100,criteria:{},stages:[{name:'HR review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}],active:true});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'irregularity',true);
  const p={employmentId,date:day(),checkIn:'10:00',checkOut:'18:00',reason:'Review clock evidence without changing overtime approval'};
  const rejected=await requestAttendanceCorrection(ctx,p);
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,rejected.correctionId)))[0]).toMatchObject({status:'pending',requestedOtMinutes:null});
  await expect(decideAttendanceCorrection(ctx,{correctionId:rejected.correctionId,decision:'rejected',rejectReason:'Original clocks confirmed',expectedStageIndex:0})).resolves.toMatchObject({status:'rejected'});
  expect((await owner.db.select().from(s.attendanceWorkflowDecision).orderBy(asc(s.attendanceWorkflowDecision.stageIndex))).map(row=>row.decision)).toEqual(['rejected']);
  const pending=await requestAttendanceCorrection(ctx,p);
  await expect(decideAttendanceCorrection(ctx,{correctionId:pending.correctionId,decision:'approved',expectedStageIndex:0})).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/TOIL/)})});
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,pending.correctionId)))[0].status).toBe('pending');
  expect((await owner.db.select().from(s.attendance).where(eq(s.attendance.id,attendanceId)))[0].checkInAt).toBe('09:00:00');
  await expect(withTenant(ctx,tx=>tx.insert(s.attendanceCorrection).values({tenantId:b.tenantId,employmentId,attendanceDate:day(),requestedOtMinutes:60,status:'rejected',reason:'Raw OT input remains protected'}))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/TOIL/)})});
  expect((await withTenant(ctx,tx=>readOvertimeSettlementForDayTx(tx,ctx,{employmentId,date:day()})))?.settlement).toMatchObject({mode:'toil',toilAccrualId:credit.id});
 });
});
