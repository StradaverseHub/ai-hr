/** Actual seated-list SQL/DTO baseline. No provider, mocked authority, paging or financial policy change. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {cancelRewardReview,createRewardUnit,decideRewardUnit,getRewardUnit,listRewardReviewStatus,postRewardUnit,saveRewardEntry} from '../packs/rewards/service';
import {emptyFacts,emptyRecommendation} from '../packs/rewards/model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {setRewardMember} from './rewards-access-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {migrateRewardMembershipFixture} from './rewards-shared-policy-fixture';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateRewardMembershipFixture);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
it('profiles active and retained seated units with independent financial and privacy expectations',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const today=todayInKualaLumpur(),year=Number(today.slice(0,4));let serial=0;
 const person=async(label:string)=>(await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional '+label,primaryEmail:randomUUID()+'@example.invalid'}).returning())[0];
 const adminPerson=await person('Rewards operator');await owner.db.update(s.appUser).set({personId:adminPerson.id}).where(eq(s.appUser.id,b.adminUserId));
 const admin={...await entitledCtx(b),personId:adminPerson.id};
 const account=async(label:string,personId?:string,role='employee')=>{
  const id=personId??(await person(label)).id,userId=await createAppUser(b.tenantId,id,role);
  return {...admin,userId,personId:id,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext;
 };
 const actors={bu:await account('BU reviewer'),bg:await account('BG reviewer'),ctro:await account('CTRO reviewer'),ec:await account('EC reviewer'),payroll:await account('payroll handoff')};
 const seatless=await account('seatless HR',undefined,'hr_admin');
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade12'}).returning();
 const hire=async(businessUnitId:string,salary:number)=>{
  const employment=await hireEmployee(admin,{person:{fullName:'Fictional Rewards employee '+serial++,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,businessUnitId,employmentType:'full_time',hiredOn:'2020-01-01'});
  await owner.db.update(s.employment).set({gradeId:grade.id,confirmationDate:'2020-04-01'}).where(eq(s.employment.id,employment.employmentId));
  await setCompensation(admin,{employmentId:employment.employmentId,basicSalary:salary,effectiveFrom:'2020-01-01'});return employment;
 };
 const [specialBu]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'ACTIVE-SPECIAL',name:'Fictional active special'}).returning();
 const specialPeople=[];for(const salary of [5000,7000,9100])specialPeople.push(await hire(specialBu.id,salary));
 const pbp=await account('own-person PBP',specialPeople[0].personId);
 const special=await createRewardUnit(admin,{name:'Fictional active cycle',year,companyId:b.companyId,businessUnitId:specialBu.id,snapshotDate:today});
 const revision=async(id:string)=>(await getRewardUnit(admin,id)).unit.revision;
 for(const role of ['bu','bg','ctro','ec','payroll'] as const)await setRewardMember(admin,special,await revision(special),actors[role].userId!,role);
 await setRewardMember(admin,special,await revision(special),admin.userId!,'payroll');await setRewardMember(admin,special,await revision(special),pbp.userId!,'pbp');
 let detail=await getRewardUnit(admin,special);
 await configureRewardFixture(admin,special,detail.unit.revision,{...detail.unit.policy,patActual:100,patTarget:100,targetMonthsBp:0,ranges:{'12':[300000,600000,1200000]},meritMatrix:{...detail.unit.policy.meritMatrix,SCORE:[500,500,500]}});
 detail=await getRewardUnit(admin,special);
 for(const row of detail.rows){
  const index=specialPeople.findIndex(person=>person.employmentId===row.source.employmentId);
  await saveRewardEntry(admin,special,await revision(special),row.id,emptyRecommendation(),{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME',confidentiality:(['standard','bg','ec']as const)[index]});
 }
 await refreshRewardFixtureBudget(admin,special);
 expect((await getRewardUnit(admin,special)).flags.filter(flag=>flag.severity==='block').map(flag=>flag.code)).toEqual([]);
 expect(await decideRewardUnit(actors.bu,special,(await getRewardUnit(actors.bu,special)).unit.revision,'submit','Reviewed fictional zero-bonus recommendations')).toBe('bg');
 const units=[special],expectedStages=new Map([[special,'bg']]);
 for(let unit=0;unit<7;unit++){
  const [bu]=await owner.db.insert(s.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'RETAINED-'+unit,name:'Fictional cohort '+unit}).returning();
  for(let employee=0;employee<16;employee++)await hire(bu.id,5000);
  const retained=unit>=3,reviewYear=retained?year-1:year;
  const id=await createRewardUnit(admin,{name:retained?'Fictional retained cycle '+unit:'Fictional active cycle '+unit,year:reviewYear,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:retained?`${reviewYear}-12-31`:today});
  await setRewardMember(admin,id,await revision(id),pbp.userId!,'pbp');
  if(retained)await cancelRewardReview(admin,id,await revision(id),'Fictional prior-year review retained after cancellation');
  units.push(id);expectedStages.set(id,retained?'withdrawn':'draft');
 }
 // Trace real application round trips. Every SQL string, parameter and result is forwarded unchanged.
 const nativeBegin=client.begin.bind(client);let active=false,counts:Record<string,number>={};
 const add=(key:string)=>counts[key]=(counts[key]??0)+1;
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index]as(native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    if(active&&typeof query[0]==='string'){
     const text=query[0].replace(/\s+/g,' ').trim().toLowerCase();add('applicationRoundTrips');
     if(text.startsWith('select app.reward_roles('))add('explicitRoleReads');
     if(text.includes('from "reward_entry"')&&text.includes('"source"')&&text.includes('"recommendation"'))add('fullRosterReads');
     if(text.includes('from "reward_cycle"'))add('detailCycleReads');
     if(text.includes('from "business_unit"'))add('detailBusinessUnitReads');
     if(text.includes('from "company"')&&text.includes('"legal_name"'))add('detailCompanyReads');
     if(text.includes('from "reward_decision"'))add('detailDecisionReads');
     if(text.includes('from "reward_calendar"'))add('calendarReads');
     if(text.includes('from "reward_member"')&&!text.includes('join "app_user"'))add('detailMemberReads');
     if(text.includes('to_regclass('))add('relationCapabilityReads');
     if(text.includes('from "reward_governance"'))add('privateGovernanceReads');
     if(text.includes('from "reward_governance_public"'))add('publicGovernanceReads');
    }
    return Reflect.apply(target.unsafe,target,query);
   };return Reflect.get(target,key,receiver);
  }}));return Reflect.apply(nativeBegin,client,args);
 })as typeof client.begin);
 const measure=async(who:SessionContext)=>{
  counts={};active=true;const began=performance.now();
  try{const value=await listRewardReviewStatus(who,[b.companyId]);return {value,elapsedMs:performance.now()-began,counts:{...counts},dtoBytes:Buffer.byteLength(JSON.stringify(value))};}finally{active=false;}
 };
 const gr=await measure(admin),pbpRead=await measure(pbp),metadata=await measure(seatless);
 expect(gr.value.rows).toHaveLength(8);expect(pbpRead.value.rows).toHaveLength(8);expect(metadata.value.rows).toHaveLength(8);
 for(const row of gr.value.rows)expect(row.status).toBe(expectedStages.get(row.id));
 const find=(rows:typeof gr.value.rows)=>rows.find(row=>row.id===special)!;
 expect(find(gr.value.rows)).toMatchObject({waiting:false,blocking:0,exceptions:0,salary:{increaseCents:60000,poolCents:84000,overLimit:false},bonus:{totalCents:0,budgetCents:0,budgetShareBp:null,overLimit:false}});
 expect(find(pbpRead.value.rows)).toMatchObject({waiting:false,salary:null,bonus:null});
 for(const row of metadata.value.rows)expect(row).toMatchObject({roles:[],people:null,verified:null,waiting:false,salary:null,bonus:null,blocking:null,exceptions:null,laterSeats:[]});
 expect(metadata.counts.fullRosterReads??0).toBe(0);
 for(const measured of [gr,pbpRead]){
  for(const query of ['detailCycleReads','detailBusinessUnitReads','detailCompanyReads','detailMemberReads','detailDecisionReads'])expect(measured.counts[query]??0,query).toBe(0);
  expect(measured.counts.calendarReads).toBe(1); // the existing authorized list's bulk calendar owner
  expect(measured.counts.fullRosterReads).toBe(8); // complete unit arithmetic is retained, never clipped
  expect(measured.counts.explicitRoleReads).toBe(16); // both existing fresh role-owner checks remain
  expect(measured.counts.privateGovernanceReads).toBe(16);expect(measured.counts.publicGovernanceReads).toBe(16);
 }
 let fullDetailDtoBytes=0,fullDetailVisibleRows=0;
 for(const id of units){const row=await getRewardUnit(admin,id);fullDetailDtoBytes+=Buffer.byteLength(JSON.stringify(row));fullDetailVisibleRows+=row.rows.length;}
 expect(fullDetailVisibleRows).toBe(115);
 const bu=await listRewardReviewStatus(actors.bu,[b.companyId]),bg=await listRewardReviewStatus(actors.bg,[b.companyId]);
 expect(find(bu.rows)).toMatchObject({waiting:false,salary:{increaseCents:25000,poolCents:84000},bonus:{totalCents:0}});
 expect(find(bg.rows)).toMatchObject({waiting:true,blocking:0,salary:{increaseCents:60000,poolCents:84000},bonus:{totalCents:0}});
 for(const [who,next]of [[actors.bg,'gr'],[admin,'ctro'],[actors.ctro,'ec'],[actors.ec,'approved']]as const){
  expect(await decideRewardUnit(who,special,(await getRewardUnit(who,special)).unit.revision,'approve','Reviewed fictional stage and zero-bonus basis')).toBe(next);
  const waiting=next==='gr'?admin:next==='ctro'?actors.ctro:next==='ec'?actors.ec:admin;
  expect(find((await listRewardReviewStatus(waiting,[b.companyId])).rows)).toMatchObject({status:next,waiting:true});
 }
 expect(find((await listRewardReviewStatus(actors.payroll,[b.companyId])).rows).waiting).toBe(false);
 await expect(postRewardUnit(actors.payroll,special,await revision(special))).rejects.toThrow('Company administrator access is required');
 expect((await getRewardUnit(admin,special)).unit.status).toBe('approved');
 const foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');expect((await listRewardReviewStatus(await entitledCtx(foreign),[b.companyId])).rows).toEqual([]);
 expect(await listRewardReviewStatus(admin,[])).toMatchObject({rows:[],emptyReason:'noScope'});
 const evidence={kind:'NATIVE_REWARDS_SEATED_LIST_PROFILE_ONLY',releaseEligible:false,units:8,retainedCancelledUnits:4,activeUnits:4,snappedEmployees:115,independentSpecialIncreaseCents:{bu:25000,bg:60000,gr:60000,pbp:null},zeroBonusBudgetAndAward:true,stageRouteVerified:true,noSeatMetadataOnly:true,crossTenantRefused:true,emptyScopeRefused:true,gr:{elapsedMs:gr.elapsedMs,queryCounts:gr.counts,summaryDtoBytes:gr.dtoBytes},pbp:{elapsedMs:pbpRead.elapsedMs,queryCounts:pbpRead.counts,summaryDtoBytes:pbpRead.dtoBytes},seatless:{elapsedMs:metadata.elapsedMs,queryCounts:metadata.counts,summaryDtoBytes:metadata.dtoBytes},fullDetailReference:{visibleRows:fullDetailVisibleRows,dtoBytes:fullDetailDtoBytes,scope:'separate canonical detail reads, not measured allocation bytes inside list'},providerCalls:0,limitations:'Native component only; not browser, whole-module or500-user acceptance.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'rewards-review-list-profile.json'),JSON.stringify(evidence,null,2));
},300000);
