/** Home Time Off: the bundled own leave inputs (core/own-leave-inputs.ts) answer every staged calculator read exactly.
 *
 * Each calculator runs twice inside ONE read-only snapshot, once on its own staged statements and once on the bundle,
 * and the two results must be identical to the byte (JSON text, key order and -0 included). The fixture covers an
 * earned Annual type with prior-year accrual, carry-forward, a carry cap forfeit and a later grant; policy, profile and
 * Anniversary-to-Calendar recalculations (and a reason that only a SQL LIKE wildcard matches); an aged forfeit; a
 * borrower that spends Annual's pool, approved and pending; a shared leave group; hidden, archived and
 * gender-restricted types with history; an anniversary-cycle type; approved, pending, rejected, half-day and part-unpaid
 * requests; a working-days request across a company holiday; entitlement tables (which keep their live resolver) and
 * a second tenant with none (which the bundle answers); a terminated employment and an employee with nothing. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/session',()=>({getSession:async()=>undefined}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
import * as schema from '../db/schema';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {decideLeave,requestLeave,leaveTypeApplySummaries,nextApprovedLeavePresenceTx,myCurrentLeaveSnapshotCards,
 setToilPolicy,createEntitlementTemplate,CARRY_FORFEIT_REASON_CAP,AGED_FORFEIT_REASON} from '../packs/leave/service';
import {hasEligibleLeaveTypeForTx,hasEligibleLeaveTypeFrom,leaveBalancesTx,leaveEntitlementBreakdowns} from '../core/read';
import {readOwnLeaveInputsTx,type OwnLeaveInputs} from '../core/own-leave-inputs';
import {readEmployeeHomeTimeOff} from '../core/employee-home-time-off';
import {coalescedNegatedSumText,coalescedSumText,parseNumeric,sqlLike} from '../lib/pg-numeric';
import {todayInKualaLumpur} from '../lib/hr-date';
import {stagedHomeTimeOff} from './helpers/home-staged-cards';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const TODAY=todayInKualaLumpur(),YEAR=Number(TODAY.slice(0,4));
const addDays=(iso:string,n:number)=>new Date(Date.parse(`${iso}T00:00:00Z`)+n*86_400_000).toISOString().slice(0,10);
type Subject={name:string;employmentId:string;ctx:SessionContext;base:Base;home:boolean};
const subjects:Subject[]=[];
let b:Base,b2:Base;
const types:Record<string,string>={};

async function leaveType(base:Base,values:Partial<typeof schema.leaveType.$inferInsert>){
 const [row]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'B_'+randomUUID().slice(0,8).toUpperCase(),
  name:'Type '+randomUUID().slice(0,6),paid:true,counting:'calendar_days',visibleToEmployee:true,allowNegativeBalance:true,...values}).returning({id:schema.leaveType.id});
 return row.id;
}
const ledger=(base:Base,employmentId:string,leaveTypeId:string,entryType:'accrual'|'debit'|'adjustment'|'in_lieu_accrual',days:string,effectiveOn:string,reason?:string)=>
 owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId,leaveTypeId,entryType,days,effectiveOn,reason:reason??null});
async function hire(base:Base,name:string,hiredOn:string,personId?:string){
 return hireEmployee(adminCtx(base),{person:personId?{id:personId}:{fullName:name,primaryEmail:`bundle_${randomUUID().slice(0,8)}@example.invalid`},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn} as Parameters<typeof hireEmployee>[1]);
}
async function employeeCtx(base:Base,personId:string):Promise<SessionContext>{
 const entitled=await entitledCtx(base,['employee']);
 return {tenantId:base.tenantId,userId:await createAppUser(base.tenantId,personId,'employee'),personId,roles:['employee'],entitlements:entitled.entitlements};
}
/** Byte equality: the JSON text (key order, -0 as 0 aside) and a strict structural match (-0, undefined, Date). */
function same(bundled:unknown,live:unknown,label:string){
 expect(JSON.stringify(bundled),label).toBe(JSON.stringify(live));
 expect(bundled,label).toStrictEqual(live);
}
/** Every statement the application client sends while `work` runs. */
async function statements<T>(work:()=>Promise<T>){
 const options=client.options as {debug?:unknown},sent:string[]=[],previous=options.debug;
 options.debug=(_connection:number,query:string)=>{sent.push(query.replace(/\s+/g,' ').trim());};
 try{return {result:await work(),sent};}finally{options.debug=previous;}
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();
 await setModule(b.tenantId,'toil','active');
 await setToilPolicy(adminCtx(b),{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
  allowFirstScheduleEligible:true,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});
 types.annual=b.annualLeaveTypeId;
 await owner.db.update(schema.leaveType).set({role:'annual',essPlacement:'primary',durations:['full_day','half_day_am','half_day_pm'],carryForwardEnabled:true,carryForwardMax:'5.00'} as never)
  .where(eq(schema.leaveType.id,b.annualLeaveTypeId));
 types.sick=await leaveType(b,{code:'SICK',name:'Sick Leave',essPlacement:'primary'});
 types.working=await leaveType(b,{code:'WORK',name:'Working Day Leave',counting:'working_days'});
 types.sg1=await leaveType(b,{code:'CPL',name:'Compassionate Leave'});
 types.sg2=await leaveType(b,{code:'MRG',name:'Marriage Leave'});
 types.hidden=await leaveType(b,{code:'HIDE',name:'Hidden Leave',visibleToEmployee:false});
 types.archived=await leaveType(b,{code:'OLD',name:'Retired Leave',archivedAt:new Date(`${YEAR-1}-06-01T00:00:00Z`)} as never);
 types.female=await leaveType(b,{code:'MAT',name:'Maternity Leave',eligibility:{gender:['female']}} as never);
 types.a2a=await leaveType(b,{code:'STUDY',name:'Study Leave',yearCycleOverride:'a2a'});
 types.borrower=await leaveType(b,{code:'EMERG',name:'Emergency Leave',balanceSourceTypeId:b.annualLeaveTypeId});
 types.sole=await leaveType(b,{code:'HOSP',name:'Hospitalisation Leave'});
 await createEntitlementTemplate(adminCtx(b),{leaveTypeId:types.sole,name:'Hospitalisation table',serviceBands:[{fromYears:0,toYears:null,days:60}],validFrom:`${YEAR-3}-01-01`});
 await seedEntitlement(adminCtx(b),{leaveTypeId:types.sick,annualDays:14,validFrom:`${YEAR-3}-01-01`});
 const [group]=await owner.db.insert(schema.leaveSharedGroup).values({tenantId:b.tenantId,name:'Special Leave',totalLimitDays:'5.00',maxDaysPerApplication:'3.00',essPlacement:'secondary'} as never)
  .returning({id:schema.leaveSharedGroup.id});
 await owner.db.insert(schema.leaveSharedGroupMember).values([{tenantId:b.tenantId,groupId:group.id,leaveTypeId:types.sg1},{tenantId:b.tenantId,groupId:group.id,leaveTypeId:types.sg2}]);
 // A company holiday inside the working-days request below: the stored request days already exclude it.
 await owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',companyId:b.companyId,holidayDate:addDays(TODAY,21),name:'Fictional company holiday'});

 const rich=await hire(b,'Rich bundle employee',`${YEAR-3}-01-15`),r=rich.employmentId;
 await ledger(b,r,types.annual,'accrual','12.00',`${YEAR-1}-01-01`);
 await ledger(b,r,types.annual,'debit','-4.00',`${YEAR-1}-03-10`);
 await ledger(b,r,types.annual,'adjustment','3.00',`${YEAR}-01-01`,'Carry forward');
 await ledger(b,r,types.annual,'adjustment','-2.00',`${YEAR}-01-01`,CARRY_FORFEIT_REASON_CAP);
 await ledger(b,r,types.annual,'accrual','14.00',`${YEAR}-01-01`);
 await ledger(b,r,types.annual,'accrual','1.50',`${YEAR}-02-01`);
 await ledger(b,r,types.annual,'adjustment','0.32',`${YEAR}-03-01`,'sys:policy_recalc:fictional');
 await ledger(b,r,types.annual,'adjustment','-0.25',`${YEAR}-03-01`,'sys:policy_recalc:fictional-down');
 await ledger(b,r,types.annual,'adjustment','0.10',`${YEAR}-03-02`,'sys:profile_recalc:fictional');
 await ledger(b,r,types.annual,'adjustment','0.30',`${YEAR}-03-03`,'sys:policyXrecalc:matches-only-through-the-like-wildcard');
 await ledger(b,r,types.a2a,'adjustment','0.20',`${YEAR-1}-02-01`,'sys:a2c_recalc:fictional');
 await ledger(b,r,types.sick,'accrual','14.00',`${YEAR}-01-01`);
 await ledger(b,r,types.sick,'adjustment','-1.00',`${YEAR}-01-05`,AGED_FORFEIT_REASON);
 await ledger(b,r,types.working,'accrual','10.00',`${YEAR}-01-01`);
 await ledger(b,r,types.sg1,'accrual','3.00',`${YEAR}-01-01`);
 await ledger(b,r,types.sg2,'accrual','3.00',`${YEAR}-01-01`);
 await ledger(b,r,types.hidden,'accrual','5.00',`${YEAR}-01-01`);
 await ledger(b,r,types.archived,'accrual','2.00',`${YEAR-1}-01-01`);
 await ledger(b,r,types.female,'accrual','98.00',`${YEAR-1}-01-01`);
 await ledger(b,r,types.female,'adjustment','-98.00',`${YEAR-1}-02-01`,'Fictional reversal');
 await ledger(b,r,types.a2a,'accrual','4.00',`${YEAR-1}-01-15`);
 await ledger(b,r,types.sole,'accrual','60.00',`${YEAR}-01-01`);
 const admin=adminCtx(b);
 const approved=await requestLeave(admin,{employmentId:r,leaveTypeId:types.annual,startDate:addDays(TODAY,14),endDate:addDays(TODAY,15),today:TODAY});
 await decideLeave(admin,{leaveRequestId:approved.leaveRequestId,decision:'approved'});
 await owner.db.update(schema.leaveRequest).set({unpaidDays:'0.50'} as never).where(eq(schema.leaveRequest.id,approved.leaveRequestId));
 await requestLeave(admin,{employmentId:r,leaveTypeId:types.annual,startDate:addDays(TODAY,30),endDate:addDays(TODAY,30),durationType:'half_day_am',today:TODAY});
 await requestLeave(admin,{employmentId:r,leaveTypeId:types.sg1,startDate:addDays(TODAY,40),endDate:addDays(TODAY,40),today:TODAY});
 const borrowed=await requestLeave(admin,{employmentId:r,leaveTypeId:types.borrower,startDate:addDays(TODAY,8),endDate:addDays(TODAY,8),today:TODAY});
 await decideLeave(admin,{leaveRequestId:borrowed.leaveRequestId,decision:'approved'});
 await requestLeave(admin,{employmentId:r,leaveTypeId:types.borrower,startDate:addDays(TODAY,60),endDate:addDays(TODAY,61),today:TODAY});
 await requestLeave(admin,{employmentId:r,leaveTypeId:types.working,startDate:addDays(TODAY,20),endDate:addDays(TODAY,22),today:TODAY});
 const rejected=await requestLeave(admin,{employmentId:r,leaveTypeId:types.sick,startDate:addDays(TODAY,50),endDate:addDays(TODAY,50),today:TODAY});
 await decideLeave(admin,{leaveRequestId:rejected.leaveRequestId,decision:'rejected',rejectReason:'Fictional clash'});
 subjects.push({name:'rich',employmentId:r,ctx:await employeeCtx(b,rich.personId),base:b,home:true});

 const first=await hire(b,'Rehired bundle employee',`${YEAR-4}-02-01`);
 await ledger(b,first.employmentId,types.annual,'accrual','10.00',`${YEAR-3}-01-01`);
 const old=await requestLeave(admin,{employmentId:first.employmentId,leaveTypeId:types.annual,startDate:addDays(TODAY,3),endDate:addDays(TODAY,3),today:TODAY});
 await decideLeave(admin,{leaveRequestId:old.leaveRequestId,decision:'approved'});
 // Terminated before the rehire starts, so the two employments never overlap.
 await owner.db.update(schema.employment).set({terminatedOn:`${YEAR-1}-12-31`}).where(eq(schema.employment.id,first.employmentId));
 const second=await hire(b,'Rehired bundle employee',`${YEAR}-01-01`,first.personId);
 await ledger(b,second.employmentId,types.annual,'accrual','7.00',`${YEAR}-01-01`);
 await requestLeave(admin,{employmentId:second.employmentId,leaveTypeId:types.sick,startDate:addDays(TODAY,5),endDate:addDays(TODAY,6),today:TODAY});
 const rehiredCtx=await employeeCtx(b,first.personId);
 subjects.push({name:'rehired',employmentId:second.employmentId,ctx:rehiredCtx,base:b,home:true});
 subjects.push({name:'terminated',employmentId:first.employmentId,ctx:rehiredCtx,base:b,home:false});
 const empty=await hire(b,'Empty bundle employee',addDays(TODAY,-3));
 subjects.push({name:'empty',employmentId:empty.employmentId,ctx:await employeeCtx(b,empty.personId),base:b,home:true});

 // A tenant without any entitlement table: every breakdown resolver is the empty one, answered from the bundle.
 b2=await seedBase();
 await owner.db.update(schema.leaveType).set({role:'annual',essPlacement:'primary',durations:['full_day','half_day_am','half_day_pm']} as never).where(eq(schema.leaveType.id,b2.annualLeaveTypeId));
 const pool=await leaveType(b2,{code:'EMERG',name:'Emergency Leave',balanceSourceTypeId:b2.annualLeaveTypeId});
 const plain=await hire(b2,'Plain bundle employee',`${YEAR-2}-05-01`),p=plain.employmentId;
 await ledger(b2,p,b2.annualLeaveTypeId,'accrual','10.67',`${YEAR-1}-05-01`);
 await ledger(b2,p,b2.annualLeaveTypeId,'adjustment','-0.67',`${YEAR}-01-01`,CARRY_FORFEIT_REASON_CAP);
 await ledger(b2,p,b2.annualLeaveTypeId,'accrual','11.00',`${YEAR}-01-01`);
 const a2=adminCtx(b2);
 const taken=await requestLeave(a2,{employmentId:p,leaveTypeId:pool,startDate:addDays(TODAY,2),endDate:addDays(TODAY,2),today:TODAY});
 await decideLeave(a2,{leaveRequestId:taken.leaveRequestId,decision:'approved'});
 await requestLeave(a2,{employmentId:p,leaveTypeId:b2.annualLeaveTypeId,startDate:addDays(TODAY,9),endDate:addDays(TODAY,9),durationType:'half_day_pm',today:TODAY});
 subjects.push({name:'noTemplates',employmentId:p,ctx:await employeeCtx(b2,plain.personId),base:b2,home:true});
},300_000);
afterAll(closeAll);

async function inSnapshot<T>(subject:Subject,read:(tx:Tx,inputs:OwnLeaveInputs)=>Promise<T>){
 return withTenant(subject.ctx,async tx=>read(tx,await readOwnLeaveInputsTx(tx,subject.employmentId,TODAY)),{readOnlySnapshot:true});
}

describe('PostgreSQL numeric and LIKE emulation',()=>{
 it('sums, negates and prints exactly as PostgreSQL does',async()=>{
  const sets=[[],['14.00'],['14.00','0.50','-3.25'],['0.10','0.20'],['-0.50','0.50'],['1.5','2.25','-0.125'],['0.00'],['-0.00','0.00'],['99999.99','0.01']];
  for(const values of sets){
   const [row]=await owner.db.execute<{sum:string;negated:string}>(sql`select coalesce(sum(x),0)::text as sum,coalesce(-sum(x),0)::text as negated
    from unnest(${`{${values.join(',')}}`}::numeric[]) x`);
   expect([coalescedSumText(values.map(parseNumeric)),coalescedNegatedSumText(values.map(parseNumeric))],values.join(',')).toEqual([row.sum,row.negated]);
  }
 });
 it('matches LIKE with its wildcards and escapes',async()=>{
  const cases:[string|null,string][]=[['sys:policy_recalc:a','sys:policy_recalc:%'],['sys:policyXrecalc:a','sys:policy_recalc:%'],['sys:policy_recalc','sys:policy_recalc:%'],
   [null,'%'],['a\nb','a%b'],['a_b','a\\_b'],['axb','a\\_b'],['100%','100\\%'],['','%'],['é','_']];
  for(const [value,pattern] of cases){
   const [row]=await owner.db.execute<{hit:boolean|null}>(sql`select ${value}::text like ${pattern} as hit`);
   expect(sqlLike(value,pattern),`${value} like ${pattern}`).toBe(row.hit===true);
  }
 });
});

describe('every leave calculator answers identically from the bundled own leave inputs',()=>{
 it('loads the bundle in one statement and answers only its own employment and transaction',async()=>{
  const [rich,other]=[subjects.find(s=>s.name==='rich')!,subjects.find(s=>s.name==='empty')!];
  await withTenant(rich.ctx,async tx=>{
   const {result:inputs,sent}=await statements(()=>readOwnLeaveInputsTx(tx,rich.employmentId,TODAY));
   expect(sent).toHaveLength(1);
   expect(inputs.ledger.length).toBeGreaterThan(15);expect(inputs.requests.length).toBeGreaterThan(5);
   expect(inputs.answers(tx,rich.employmentId)).toBe(true);
   expect(inputs.answers(tx,other.employmentId)).toBe(false);
   // Another employment through the same bundle reads live and returns that employment's own figures.
   same(await leaveBalancesTx(tx,rich.ctx,other.employmentId,'en',{},inputs),await leaveBalancesTx(tx,rich.ctx,other.employmentId,'en',{}),'foreign employment');
  },{readOnlySnapshot:true});
  const carried=await withTenant(rich.ctx,tx=>readOwnLeaveInputsTx(tx,rich.employmentId,TODAY),{readOnlySnapshot:true});
  await withTenant(rich.ctx,async tx=>expect(carried.answers(tx,rich.employmentId)).toBe(false),{readOnlySnapshot:true});
 });
 for(const name of ['rich','rehired','terminated','empty','noTemplates']){
  it(`${name}: balances, breakdowns, Apply figures, cards, eligibility and next approved leave`,async()=>{
   const subject=subjects.find(s=>s.name===name)!,id=subject.employmentId,ctx=subject.ctx;
   await inSnapshot(subject,async(tx,inputs)=>{
    for(const opts of [{},{includeArchived:false},{asOf:`${YEAR-1}-12-31`},{asOf:TODAY},{includeHidden:true,includeIneligible:true,includeArchived:true}])
     same(await leaveBalancesTx(tx,ctx,id,'en',opts,inputs),await leaveBalancesTx(tx,ctx,id,'en',opts),`${name} balances ${JSON.stringify(opts)}`);
    same(await leaveBalancesTx(tx,ctx,id,'ms',{},inputs),await leaveBalancesTx(tx,ctx,id,'ms',{}),`${name} balances ms`);
    const typeIds=inputs.types.map(type=>type.id);
    const items=typeIds.flatMap(leaveTypeId=>[TODAY,`${YEAR}-12-31`,`${YEAR-1}-12-31`,addDays(TODAY,45)].map(asOf=>({leaveTypeId,asOf})));
    same(await leaveEntitlementBreakdowns(ctx,id,items,'en',tx,inputs),await leaveEntitlementBreakdowns(ctx,id,items,'en',tx),`${name} breakdowns`);
    same([...await leaveTypeApplySummaries(ctx,id,typeIds,tx,inputs)],[...await leaveTypeApplySummaries(ctx,id,typeIds,tx)],`${name} Apply figures`);
    same(await myCurrentLeaveSnapshotCards(ctx,id,{today:TODAY,locale:'en'},tx,inputs),await myCurrentLeaveSnapshotCards(ctx,id,{today:TODAY,locale:'en'},tx),`${name} cards`);
    same(await hasEligibleLeaveTypeFrom(tx,id,inputs),await hasEligibleLeaveTypeForTx(tx,id),`${name} eligibility`);
    same(inputs.nextApproved,await nextApprovedLeavePresenceTx(tx,id,TODAY),`${name} next approved`);
   });
  },120_000);
 }
 it('the rich fixture really carries what it claims',async()=>{
  const rich=subjects.find(s=>s.name==='rich')!;
  await inSnapshot(rich,async(tx,inputs)=>{
   const all=await leaveBalancesTx(tx,rich.ctx,rich.employmentId,'en',{includeHidden:true,includeIneligible:true,includeArchived:true});
   const shown=await leaveBalancesTx(tx,rich.ctx,rich.employmentId,'en',{});
   for(const id of [types.hidden,types.archived,types.female])expect(all.some(row=>row.leaveTypeId===id)).toBe(true);
   for(const id of [types.hidden,types.archived,types.female])expect(shown.some(row=>row.leaveTypeId===id)).toBe(false);
   expect(shown.find(row=>row.leaveTypeId===types.borrower)?.sharedBalance).not.toBeNull();
   expect(inputs.requests.some(row=>row.unpaidDays==='0.50')).toBe(true);
   expect(inputs.requests.some(row=>row.durationType==='half_day_am'&&row.status==='pending')).toBe(true);
   expect(inputs.ledger.some(row=>row.reason?.startsWith('sys:policyXrecalc'))).toBe(true);
   expect(inputs.nextApproved).not.toBeNull();
   const cards=await myCurrentLeaveSnapshotCards(rich.ctx,rich.employmentId,{today:TODAY,locale:'en'},tx,inputs);
   expect(cards.length).toBeGreaterThan(4);expect(cards.some(card=>card.canApplyFor!==null&&card.pending!==null)).toBe(true);
  });
 });
});

describe('Home Time Off from one bundled read',()=>{
 it('returns exactly the staged card for every Home subject, with fewer statements',async()=>{
  for(const subject of subjects.filter(s=>s.home)){
   const staged=await statements(()=>stagedHomeTimeOff(subject.ctx,subject.employmentId,'en'));
   const bundled=await statements(()=>readEmployeeHomeTimeOff(subject.ctx,subject.employmentId,'en'));
   same(bundled.result,staged.result,subject.name);
   console.info('[home-time-off-bundle] '+JSON.stringify({subject:subject.name,stagedStatements:staged.sent.length,bundledStatements:bundled.sent.length}));
   expect(bundled.sent.length).toBeLessThan(staged.sent.length);
   // Without an entitlement table in force, the one bundled statement is the only leave read: the rest are the
   // transaction, identity and principal proofs (which a Home stream's shared snapshot answers once).
   const leaveReads=bundled.sent.filter(text=>/leave_ledger|leave_request|leave_type|entitlement_template/.test(text));
   if(subject.name==='noTemplates')expect(leaveReads).toHaveLength(1);
  }
 },120_000);
 it('refuses a terminated or foreign employment before reading any leave figure',async()=>{
  const terminated=subjects.find(s=>s.name==='terminated')!,foreign=subjects.find(s=>s.name==='noTemplates')!;
  for(const [ctx,id] of [[terminated.ctx,terminated.employmentId],[terminated.ctx,foreign.employmentId]] as const){
   const {result,sent}=await statements(()=>readEmployeeHomeTimeOff(ctx,id,'en').then(()=>'ok',error=>error as {code?:string}));
   expect(result).toMatchObject({code:'employmentUnavailable'});
   expect(sent.some(text=>/leave_ledger|jsonb_build_object\('types'/.test(text))).toBe(false);
  }
 });
});
