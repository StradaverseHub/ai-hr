/** b31981c0: the simplified Overtime Patterns editor hides companies, currency, duration policies, rates and lifecycle.
 * Real-database proof through the actual server action: hidden values of an existing pattern survive an edit
 * byte-for-byte whatever the browser posts, new drafts get server-derived values, unauthorized callers write nothing,
 * and an activated pattern's recorded calculation, payable duration and preview stay identical. */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,setModule,type Base} from './harness';
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
import {createCompany} from '../core/admin';
import type {OvertimeCondition,OvertimePattern} from '../lib/overtime-pattern-model';
import {activateOvertimePattern,createOvertimeCalculationOwner,readOvertimeCalculationTx,readOvertimeDurationsTx,saveOvertimePatternAssignment,saveOvertimePatternDraft,validateOvertimePatternActivation,type CanonicalOvertimeSnapshot} from '../packs/attendance/overtime-patterns';

const session=vi.hoisted(()=>({current:null as null|{s:unknown;scopeIds:string[]}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:vi.fn(async()=>{if(!session.current)throw new Error('authorization-refused');return session.current;})}));
import {saveOvertimeDraftAction} from '../app/admin/attendance/settings/overtime-patterns/actions';

let b:Base,employmentId:string,attendanceId:string,earningId:string;const day=()=>todayInKualaLumpur();
const plus=(n:number)=>{const d=new Date(day()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const yes=(id:string):OvertimeCondition=>({id,type:'constant',value:true});
const actAs=(ctx:SessionContext,scopeIds:string[])=>{session.current={s:ctx,scopeIds};};
/** Every hidden axis set away from the new-draft defaults: two companies, session, latest, SGD, rates, rounding. */
function hiddenHeavy(currency='SGD'):OvertimePattern {
 return {v:1,currency:{code:currency,minorScale:2},definitions:[],eligibilityBasis:'session',durationAllocation:'latest',eligibility:yes('saved_eligibility'),
  eligibleMinutes:{id:'eligible',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:{step:'15',mode:'down'},deductions:[],
  rates:[{id:'rate',name:'Saved fictional rate',description:'Fixture policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'session',tierMode:'marginal',
   tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningId,currency},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency,value:'25'}}}]}],
  paymentCap:{id:'cap',type:'literal',unit:'money',currency,value:'500'},moneyRounding:{stage:'line',mode:'halfEven'}};
}
function payable():OvertimePattern {
 return {v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'earliest',eligibility:yes('eligible'),eligibleMinutes:{id:'fraction',type:'literal',unit:'minutes',value:'60.5'},durationCap:null,durationRounding:null,deductions:[],
  rates:[{id:'rate',name:'Test payment',description:'Fixture policy',priority:0,when:yes('rate_when'),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earningId,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:'25'}}}]}],
  paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
}
const edited:OvertimeCondition={id:'edited_eligibility',type:'group',logic:'or',children:[yes('edited_always')]};
/** What a stale or tampered browser could post: different companies, currency, duration policies and rates. */
function tampered(otherCompanyId:string) {
 return {code:'BROWSER_CODE',name:'Edited fictional name',description:'Edited',creationCompanyId:otherCompanyId,companyIds:[otherCompanyId],
  definition:{...payable(),eligibility:edited,rates:[],paymentCap:null,eligibilityBasis:'day',durationAllocation:'earliest',currency:{code:'MYR',minorScale:2}}} as never;
}
function known<T>(value:T){return {state:'known' as const,value,provenance:{owner:'attendance' as const,reference:attendanceId,asOf:day(),basis:'recorded' as const}};}
function snapshot():CanonicalOvertimeSnapshot{return {resolvedLegacyRuleId:null,referenceDigest:'c'.repeat(64),input:{layer:'raw',sessionGranularity:'recorded',source:{tenantId:b.tenantId,employmentId,attendanceId,date:day(),inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},currency:{code:'MYR',minorScale:2},facts:{companyId:known(b.companyId),employmentId:known(employmentId),dayType:known('workday'),actualWorkingMinutes:known('120'),requiredWorkingMinutes:known('0'),basicSalary:{state:'unknown',reason:'No financial visibility'}},resources:[],approval:{status:'approved',minutes:known('120'),provenance:{owner:'approval',reference:'approved-day',asOf:day(),basis:'recorded'}},segments:[{id:'segment',sessionId:'session',dayType:known('workday'),clock:{state:'unknown',reason:'Not needed for this policy'},rawMinutes:known('120'),approvedMinutes:known('120')}]}};}
async function stored(versionId:string){
 const [version]=await owner.db.select().from(s.overtimePatternVersion).where(eq(s.overtimePatternVersion.id,versionId));
 const [pattern]=await owner.db.select().from(s.overtimePattern).where(eq(s.overtimePattern.id,version.patternId));
 const companies=(await owner.db.select({id:s.overtimePatternVersionCompany.companyId}).from(s.overtimePatternVersionCompany).where(eq(s.overtimePatternVersionCompany.versionId,versionId)).orderBy(asc(s.overtimePatternVersionCompany.companyId))).map(row=>row.id);
 return {version,pattern,companies};
}
async function scopedAdminOf(companyId:string):Promise<SessionContext>{
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Scoped fictional administrator',primaryEmail:`ot-scoped-${randomUUID()}@example.test`}).returning();const personId=person.id;
 const userId=await createAppUser(b.tenantId,personId,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return {...adminCtx(b),userId,personId,grants:[{role:'hr_admin',companyId}]} as SessionContext;
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 session.current=null;await resetDb();b=await seedAttendanceSubmissionBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'OT Editor Employee',primaryEmail:`ot-editor-${randomUUID()}@example.test`}).returning();
 const [employee]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,companyId:b.companyId,personId:person.id,hiredOn:plus(-10)}).returning();employmentId=employee.id;
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:plus(-10)});
 const [attendance]=await owner.db.insert(s.attendance).values({tenantId:b.tenantId,employmentId,attendanceDate:day(),checkInAt:'09:00:00',checkOutAt:'18:00:00',otMinutes:120}).returning();attendanceId=attendance.id;
 const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'OT',name:'OT fixture',kind:'allowance'}).returning();earningId=earning.id;
});

describe('editor saves never take hidden Overtime Pattern values from the browser (b31981c0)',()=>{
 it('keeps companies, currency, duration policies, rates and advanced fields byte-identical when editing an existing draft',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Second fictional OT employer',country:'MY',currency:'MYR'});
  const saved=await saveOvertimePatternDraft(ctx,{draft:{code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId,other.id],name:'Saved fictional pattern',description:'Fixture',definition:hiddenHeavy()}});
  const before=await stored(saved.versionId);
  expect(before.companies).toEqual([b.companyId,other.id].sort());
  actAs(ctx,[other.id]);
  const result=await saveOvertimeDraftAction({patternId:saved.patternId,versionId:saved.versionId,expectedRevision:saved.revision,draft:tampered(other.id)});
  expect(result).toMatchObject({ok:true,value:{patternId:saved.patternId,versionId:saved.versionId}});
  const after=await stored(saved.versionId);
  expect(after.companies).toEqual(before.companies);
  expect(after.pattern.creationCompanyId).toBe(b.companyId);expect(after.pattern.code).toBe(before.pattern.code);
  expect(after.version.name).toBe('Edited fictional name');expect(after.version.revision).toBe(before.version.revision+1);
  const {eligibility:afterEligibility,...afterHidden}=after.version.definition as unknown as Record<string,unknown>,{eligibility:_beforeEligibility,...beforeHidden}=before.version.definition as unknown as Record<string,unknown>;
  expect(afterEligibility).toEqual(edited);
  expect(JSON.stringify(afterHidden)).toBe(JSON.stringify(beforeHidden));
  expect(afterHidden).toMatchObject({currency:{code:'SGD',minorScale:2},eligibilityBasis:'session',durationAllocation:'latest'});
  const audits=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,saved.patternId)).orderBy(asc(s.domainEvent.id));
  expect(audits.at(-1)).toMatchObject({eventType:'overtime.draft.saved',payload:expect.objectContaining({versionId:saved.versionId})});
  expect([...(audits.at(-1)!.payload as {companyIds:string[]}).companyIds].sort()).toEqual([b.companyId,other.id].sort());
 });
 it('files a new pattern under the single selected company with its currency, and refuses several companies without writing',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Third fictional OT employer',country:'MY',currency:'SGD'});
  actAs(ctx,[b.companyId,other.id]);
  expect(await saveOvertimeDraftAction({starterKey:'ot15',draft:tampered(other.id)})).toEqual({ok:false,code:'invalid',notice:'chooseOneCompany'});
  expect(await owner.db.select({id:s.overtimePattern.id}).from(s.overtimePattern).where(eq(s.overtimePattern.tenantId,b.tenantId))).toEqual([]);
  actAs(ctx,[other.id]);
  const result=await saveOvertimeDraftAction({starterKey:'ot15',draft:tampered(b.companyId)});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error('Expected a saved draft');
  const created=await stored(result.value.versionId);
  expect(created.pattern.creationCompanyId).toBe(other.id);expect(created.companies).toEqual([other.id]);expect(created.pattern.code).toBe('BROWSER_CODE');
  expect(created.version.activatedAt).toBeNull();
  expect(created.version.definition).toMatchObject({currency:{code:'SGD',minorScale:2},eligibilityBasis:'day',durationAllocation:'earliest',paymentCap:null,eligibility:edited});
  expect((created.version.definition as unknown as OvertimePattern).rates.map(rate=>rate.name)).toEqual(['OT 1.5']);
 });
 it('refuses a caller without authority over every saved company, or outside the pattern, and changes nothing',async()=>{
  const ctx=adminCtx(b),other=await createCompany(ctx,{legalName:'Fourth fictional OT employer',country:'MY',currency:'MYR'});
  const shared=await saveOvertimePatternDraft(ctx,{draft:{code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId,other.id],name:'Shared fictional pattern',description:'Fixture',definition:hiddenHeavy()}});
  const before=await stored(shared.versionId);
  actAs(await scopedAdminOf(b.companyId),[b.companyId]);
  expect(await saveOvertimeDraftAction({patternId:shared.patternId,versionId:shared.versionId,expectedRevision:shared.revision,draft:tampered(b.companyId)})).toEqual({ok:false,code:'permission'});
  expect(await stored(shared.versionId)).toEqual(before);
  const own=await saveOvertimePatternDraft(ctx,{draft:{code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Own fictional pattern',description:'Fixture',definition:hiddenHeavy('MYR')}});
  const ownBefore=await stored(own.versionId);
  actAs(await scopedAdminOf(other.id),[other.id]);
  expect(await saveOvertimeDraftAction({patternId:own.patternId,versionId:own.versionId,expectedRevision:own.revision,draft:tampered(other.id)})).toEqual({ok:false,code:'unavailable'});
  expect(await stored(own.versionId)).toEqual(ownBefore);
  session.current=null;
  await expect(saveOvertimeDraftAction({patternId:own.patternId,versionId:own.versionId,expectedRevision:own.revision,draft:tampered(other.id)})).rejects.toThrow('authorization-refused');
  expect(await stored(own.versionId)).toEqual(ownBefore);
 });
 it('leaves an activated pattern, its recorded calculation, payable duration and preview unchanged',async()=>{
  const ctx=adminCtx(b),saved=await saveOvertimePatternDraft(ctx,{draft:{code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Paying fictional pattern',description:'Fixture',definition:payable()}});
  const check=await validateOvertimePatternActivation(ctx,{versionId:saved.versionId,expectedRevision:saved.revision});expect(check.issues).toEqual([]);
  await activateOvertimePattern(ctx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest!,effectiveFrom:day()});
  await saveOvertimePatternAssignment(ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[employmentId]},priority:1,from:day(),to:null});
  const api=createOvertimeCalculationOwner(async()=>snapshot());
  const recorded=await withTenant(ctx,async tx=>{const prepared=await api.prepareTx(tx,ctx,{employmentId,date:day()});return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:0});});
  expect(recorded.status).toBe('recorded');
  const read=()=>withTenant(ctx,async tx=>({calculation:await readOvertimeCalculationTx(tx,ctx,{employmentId,date:day()}),durations:await readOvertimeDurationsTx(tx,ctx,{entries:[{employmentId,date:day()}]})}));
  const beforeRead=await read(),beforeStored=await stored(saved.versionId),beforePreview=await api.preview(ctx,{patternId:saved.patternId,versionId:saved.versionId,employmentId,date:day()});
  expect(beforeRead.calculation?.lines.length).toBeGreaterThan(0);expect(beforeRead.durations[0].payableExact).toEqual({unit:'minutes',numerator:'121',denominator:'2'});
  expect(beforePreview.status).toBe('ready');
  const [version]=await owner.db.select().from(s.overtimePatternVersion).where(eq(s.overtimePatternVersion.id,saved.versionId));
  actAs(ctx,[b.companyId]);
  for(const expectedRevision of [version.revision,version.revision+1])
   expect(await saveOvertimeDraftAction({patternId:saved.patternId,versionId:saved.versionId,expectedRevision,draft:tampered(b.companyId)})).toEqual({ok:false,code:'invalid'});
  expect(await stored(saved.versionId)).toEqual(beforeStored);
  expect(await read()).toEqual(beforeRead);
  expect(await api.preview(ctx,{patternId:saved.patternId,versionId:saved.versionId,employmentId,date:day()})).toEqual(beforePreview);
 });
});
