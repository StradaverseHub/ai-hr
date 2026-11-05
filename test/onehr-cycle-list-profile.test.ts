/** Native OneHR-only list baseline: purpose-scoped metadata/progress, never compensation. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignRole,createCompany,createDepartment,revokeRole,setCompanyParent} from '../core/admin';
import {hireEmployee} from '../core/org';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {paginateRows,parsePageQuery} from '../lib/pagination';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
it('profiles many OneHR cycles after native purpose authorization with descendant, own-work and no-pay controls',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'performance','active');const admin=await entitledCtx(b),year=Number(todayInKualaLumpur().slice(0,4));
 const other=await createCompany(admin,{legalName:'Fictional unrelated OneHR company'}),child=await createCompany(admin,{legalName:'Fictional child OneHR company'});
 await setCompanyParent(admin,{companyId:child.id,parentCompanyId:b.companyId});
 const otherDept=await createDepartment(admin,{companyId:other.id,name:'Fictional other department'}),childDept=await createDepartment(admin,{companyId:child.id,name:'Fictional child department'});
 const hire=(label:string,companyId=b.companyId,departmentId=b.deptA)=>hireEmployee(admin,{person:{fullName:'Fictional '+label,primaryEmail:randomUUID()+'@example.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const subject=await hire('assigned participant'),partnerPerson=await hire('performance partner'),manager=await hire('ordinary colleague'),otherPerson=await hire('other participant',other.id,otherDept.id),childPerson=await hire('child participant',child.id,childDept.id);
 const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional grade12'}).returning();await owner.db.update(s.employment).set({gradeId:grade.id,confirmationDate:'2020-04-01'}).where(eq(s.employment.tenantId,b.tenantId));
 const ordinaryId=await createAppUser(b.tenantId,subject.personId,'employee'),partnerId=await createAppUser(b.tenantId,partnerPerson.personId,'employee'),groupId=await createAppUser(b.tenantId,manager.personId,'employee');
 const grant=await assignRole(admin,{appUserId:partnerId,role:'performance_partner',companyId:b.companyId});await assignRole(admin,{appUserId:groupId,role:'performance_partner'});
 const ordinary:SessionContext={...admin,userId:ordinaryId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const partner:SessionContext={...ordinary,userId:partnerId,personId:partnerPerson.personId,roles:['employee','performance_partner'],grants:[{role:'employee',companyId:null},{role:'performance_partner',companyId:b.companyId}]};
 const group:SessionContext={...ordinary,userId:groupId,personId:manager.personId,roles:['employee','performance_partner'],grants:[{role:'employee',companyId:null},{role:'performance_partner',companyId:null}]};
 const {cycleId:active}=await perf.createCycle(admin,{name:'Fictional active own-assignment cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`,eligibilityRules:{companyIds:[b.companyId]}});
 await perf.configureOnehrCycle(admin,active,null,defaultPolicy(framework));await perf.openCycle(admin,{cycleId:active});
 expect((await perf.onehrAssignments(ordinary)).reviews.some(review=>review.cycle=== 'Fictional active own-assignment cycle')).toBe(true);
 const cycles:Array<typeof s.reviewCycle.$inferInsert>=[],families:Array<typeof s.onehrCycle.$inferInsert>=[],reviews:Array<typeof s.performanceReview.$inferInsert>=[],expected=new Map<string,{total:number;submitted:number;acknowledged:number}>();
 const permitted:string[]=[],allFamily:string[]=[],hidden:string[]=[];
 for(let index=0;index<368;index++){
  const companyId=index<160?b.companyId:index<256?child.id:index<320?other.id:index<336?null:b.companyId;
  const onehr=index<336,id=randomUUID(),periodStart=new Date(Date.UTC(2018,0,index+1)).toISOString().slice(0,10);
  cycles.push({id,tenantId:b.tenantId,companyId,name:'Fictional retained cycle '+String(index).padStart(4,'0'),periodStart,periodEnd:'2019-12-31',status:'closed',releasedAt:new Date('2020-01-01T00:00:00Z'),ratingScale:[{value:1,label:'Fictional rating'}],meritBudget:{kind:'amount',value:9999999},eligibilityRules:companyId?{companyIds:[companyId]}:null,stages:[{kind:'year_end',label:'Year-end'}]});
  if(onehr){families.push({cycleId:id,tenantId:b.tenantId,policy:defaultPolicy(framework)});allFamily.push(id);}
  const status=index%3===0?'submitted' as const:index%3===1?'acknowledged' as const:'not_started' as const;
  reviews.push({tenantId:b.tenantId,cycleId:id,employmentId:companyId===child.id?childPerson.employmentId:companyId===other.id?otherPerson.employmentId:subject.employmentId,status,compActionStatus:'recommended'});
  expected.set(id,{total:1,submitted:status==='not_started'?0:1,acknowledged:status==='acknowledged'?1:0});
  if(index<256)permitted.push(id);else hidden.push(id);
 }
 // A retained metadata/progress restore is fixture data, not an attempt by the partner to create cycles.
 for(let offset=0;offset<cycles.length;offset+=100)await owner.db.insert(s.reviewCycle).values(cycles.slice(offset,offset+100));
 for(let offset=0;offset<families.length;offset+=100)await owner.db.insert(s.onehrCycle).values(families.slice(offset,offset+100));
 for(let offset=0;offset<reviews.length;offset+=100)await owner.db.insert(s.performanceReview).values(reviews.slice(offset,offset+100));
 expected.set(active,{total:3,submitted:0,acknowledged:0});
 const fullBegan=performance.now(),reference=await perf.listOnehrAdminCycles(partner),fullMs=performance.now()-fullBegan;
 expect(new Set(reference.map(row=>row.id))).toEqual(new Set([active,...permitted]));expect(reference).toHaveLength(257);
 for(const row of reference){expect({total:row.total,submitted:row.submitted,acknowledged:row.acknowledged}).toEqual(expected.get(row.id));expect('pendingComp'in row).toBe(false);expect('meritBudget'in row).toBe(false);}
 expect(reference.some(row=>hidden.includes(row.id))).toBe(false);
 const nativeBegin=client.begin.bind(client);let activeTrace=false,roundTrips=0,metadataReads=0,purposeClause=true,unusedConfig=false,payProgressRead=false;const aggregateWidths:number[]=[];
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index]as(native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){if(key==='unsafe')return(...query:unknown[])=>{
   if(activeTrace&&typeof query[0]==='string'){
    const text=query[0];roundTrips++;payProgressRead||=text.includes('"comp_action_status"');
    if(text.includes('from "review_cycle"')&&text.includes('join "performance_onehr_cycle"')){metadataReads++;purposeClause&&=text.includes('app.onehr_cycle_admin(');unusedConfig||=text.includes('"merit_budget"')||text.includes('"rating_scale"')||text.includes('"stages"');}
    if(text.includes('from "performance_review"')&&text.includes('group by'))aggregateWidths.push(Array.isArray(query[1])?query[1].length:0);
   }
   return Reflect.apply(target.unsafe,target,query);
  };return Reflect.get(target,key,receiver);}}));return Reflect.apply(nativeBegin,client,args);
 })as typeof client.begin);
 activeTrace=true;const began=performance.now(),page=paginateRows(await perf.listOnehrAdminCycles(partner),parsePageQuery()),elapsedMs=performance.now()-began;activeTrace=false;
 expect(page.rows).toEqual(reference.slice(0,25));expect(page.state.total).toBe(257);expect(purposeClause).toBe(true);expect(payProgressRead).toBe(false);
 expect((await perf.listOnehrAdminCycles(group)).map(row=>row.id).sort()).toEqual([active,...allFamily].sort());
 expect(await perf.listOnehrAdminCycles(ordinary)).toEqual([]);
 expect((await withTenant(ordinary,tx=>tx.select({id:s.performanceReview.id}).from(s.performanceReview).where(eq(s.performanceReview.cycleId,active)))).length).toBeGreaterThan(0);
 const foreign=await seedBase();await setModule(foreign.tenantId,'performance','active');expect(await perf.listOnehrAdminCycles(await entitledCtx(foreign))).toEqual([]);
 await revokeRole(admin,{roleAssignmentId:grant.id});expect(await perf.listOnehrAdminCycles(partner)).toEqual([]);
 const evidence={kind:'NATIVE_ONEHR_CYCLE_LIST_PROFILE_ONLY',releaseEligible:false,retainedMetadataCycles:368,onehrFamilyCycles:336,authorizedPartnerCycles:257,authorizedDescendantCycles:96,groupAuthorizedCycles:337,firstPageRows:25,fullMs,pageCallerMs:elapsedMs,applicationRoundTrips:roundTrips,metadataReads,nativePerCyclePurposeClause:purposeClause,unusedConfigurationColumnsRead:unusedConfig,aggregateCycleParameterWidths:aggregateWidths,compensationProgressColumnRead:payProgressRead,independentProgressCounts:true,ownAssignmentsRetainedWithoutAdminList:true,genericOtherCompanyAndGroupCycleWithheld:true,foreignTenantRefused:true,staleRevokedGrantWithheld:true,providerCalls:0,limitations:'Native full-list/page-caller component only; no browser or500-user acceptance. Retained metadata/progress fixtures are not a full historical-cycle processing fixture.'};
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'onehr-cycle-list-profile.json'),JSON.stringify(evidence,null,2));
},300000);
