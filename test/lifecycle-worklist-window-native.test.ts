/** Native date windows: retain the canonical worklist while avoiding materializing irrelevant history. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {company,itAsset,itRequisition,lcCase,lcStaff} from '../db/schema';
import {lifecycleWorklist,isExpiryDue,isLastWorkingDayDue,isOnboardingStartDue,type WorklistItem} from '../core/lifecycle-worklist';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
const plus=(day:string,n:number)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
it('pushes inclusive HR-local date windows down without losing overdue cases, statuses or company authority',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');const ctx=await entitledCtx(b),today=todayInKualaLumpur();
 const makeCase=(kind:string,number:string,day:string|null)=>({id:randomUUID(),tenantId:b.tenantId,companyId:b.companyId,kind,number,fullName:number,employeeNo:number,status:'in_progress',outcome:kind==='offboarding'?'accepted':'pending',lastWorkingDay:kind==='offboarding'?day:null,joinDate:kind==='onboarding'?day:null,notes:'Fictional retained details '.repeat(30)});
 const cases=Array.from({length:1000},(_,i)=>makeCase(i%2?'onboarding':'offboarding','FUTURE-'+i,plus(today,400)));
 const expected:WorklistItem[]=[];
 for(const n of [-365,0,3,4]){const row=makeCase('offboarding','OFF-'+n,plus(today,n));cases.push(row);if(isLastWorkingDayDue(row.lastWorkingDay,today))expected.push({kind:'lastWorkingDay',ref:row.number,label:row.fullName,detail:'2',days:n,href:'/lifecycle/offboarding/'+row.number});}
 const reqs=[];
 for(const n of [-8,-7,0,3,4]){const row=makeCase('onboarding','ON-'+n,plus(today,n));cases.push(row);const number='REQ-'+n;reqs.push({tenantId:b.tenantId,companyId:b.companyId,caseId:row.id,kind:'requisition',number,status:'open',approvalStatus:'approved',fullName:row.fullName,employeeNo:row.employeeNo});if(isOnboardingStartDue(row.joinDate,today))expected.push({kind:'onboardingStart',ref:row.number,label:row.fullName,detail:number+'|0|0',days:n,href:'/lifecycle/requisitions/'+number});}
 cases.push(makeCase('offboarding','OFF-NULL',null),makeCase('onboarding','ON-NULL',null),{...makeCase('offboarding','OFF-REJECTED',today),outcome:'rejected'},{...makeCase('offboarding','OFF-CANCELLED',today),status:'cancelled'},{...makeCase('onboarding','ON-CANCELLED',today),status:'cancelled'});
 const deferred=makeCase('onboarding','ON-COMPLETED-REQ',today);cases.push(deferred);reqs.push({tenantId:b.tenantId,companyId:b.companyId,caseId:deferred.id,kind:'requisition',number:'REQ-COMPLETED',status:'completed',approvalStatus:'approved',fullName:deferred.fullName,employeeNo:deferred.employeeNo});
 for(let offset=0;offset<cases.length;offset+=200)await owner.db.insert(lcCase).values(cases.slice(offset,offset+200));await owner.db.insert(itRequisition).values(reqs);
 const assets:Array<typeof itAsset.$inferInsert>=Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,companyId:b.companyId,code:'FUTURE-ASSET-'+i,assetType:'laptop',warrantyEnd:plus(today,400),extra:{fictionalDetails:'Fictional inventory detail '.repeat(30)}}));
 for(const [index,n]of [-31,-30,0,60,61].entries()){const code='ASSET-'+n;assets.push({tenantId:b.tenantId,companyId:b.companyId,code,assetType:'laptop',status:['in_stock','issued','returned','under_repair','in_stock'][index],warrantyEnd:plus(today,n)});if(isExpiryDue(plus(today,n),today))expected.push({kind:'expiry',ref:code,label:'laptop',detail:'warranty',days:n,href:'/lifecycle/assets/'+code});}
 assets.push({tenantId:b.tenantId,companyId:b.companyId,code:'ASSET-DUAL',assetType:'laptop',warrantyEnd:plus(today,2),leaseEnd:plus(today,2)},{tenantId:b.tenantId,companyId:b.companyId,code:'ASSET-RETIRED',assetType:'laptop',status:'retired',warrantyEnd:today},{tenantId:b.tenantId,companyId:b.companyId,code:'ASSET-NULL',assetType:'laptop'});
 for(const detail of ['warranty','lease'])expected.push({kind:'expiry',ref:'ASSET-DUAL',label:'laptop',detail,days:2,href:'/lifecycle/assets/ASSET-DUAL'});
 for(let offset=0;offset<assets.length;offset+=200)await owner.db.insert(itAsset).values(assets.slice(offset,offset+200));
 // Unknown/deferred statuses are rejected by the native owners, never normalized into a live state.
 await expect(owner.db.insert(lcCase).values({...makeCase('onboarding','INVALID-DEFERRED',today),status:'deferred'})).rejects.toThrow();
 await expect(owner.db.insert(lcCase).values({...makeCase('offboarding','INVALID-OUTCOME',today),outcome:'unknown'})).rejects.toThrow();
 await expect(owner.db.insert(itRequisition).values({...reqs[0],number:'INVALID-REQ-STATUS',status:'deferred'})).rejects.toThrow();
 await expect(owner.db.insert(itAsset).values({tenantId:b.tenantId,companyId:b.companyId,code:'INVALID-ASSET-STATUS',assetType:'laptop',status:'unknown'})).rejects.toThrow();
 const nativeBegin=client.begin.bind(client);const reads:Array<{table:string;bounded:boolean;listOnly:boolean}>=[];
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{const i=args.findIndex(arg=>typeof arg==='function'),callback=args[i]as(native:typeof client)=>unknown;args[i]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){if(key==='unsafe')return(...query:unknown[])=>{if(typeof query[0]==='string'){const text=query[0].toLowerCase();for(const table of ['lc_case','it_asset'])if(text.includes('from "'+table+'"'))reads.push({table,bounded:text.includes(' between ')||text.includes(' <= '),listOnly:!text.includes('"notes"')&&!text.includes('"nric_passport"')&&!text.includes('"extra"')});}return Reflect.apply(target.unsafe,target,query);};return Reflect.get(target,key,receiver);}}));return Reflect.apply(nativeBegin,client,args);})as typeof client.begin);
 const began=performance.now(),actual=await lifecycleWorklist(ctx),elapsedMs=performance.now()-began;
 const evidence:Record<string,unknown>={kind:'NATIVE_LIFECYCLE_WORKLIST_WINDOW_COMPONENT_ONLY',releaseEligible:false,todayHrLocal:today,retainedCases:cases.length,retainedAssets:assets.length,rows:actual.length,elapsedMs,reads,providerCalls:0,nativeUnknownStatusesRefused:true,limitations:'Native retained-history component only; not browser, CRUD throughput or500-user acceptance.'};
 try{
  expect(actual).toEqual(expected.sort((a,b)=>a.days-b.days||a.ref.localeCompare(b.ref)));evidence.exactBoundaryRowsAndOrder=true;
  expect(reads).toHaveLength(3);expect(reads.every(read=>read.bounded&&read.listOnly),'Case and inventory worklist reads must apply canonical date windows and project only required fields natively').toBe(true);
  const userId=await createAppUser(b.tenantId,null,'employee');const employee:SessionContext={...await entitledCtx(b,['employee']),userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};expect(await lifecycleWorklist(employee)).toEqual([]);
  await owner.db.insert(lcStaff).values({tenantId:b.tenantId,userId,companyId:b.companyId,level:'agent'});
  const [otherCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional other worklist scope'}).returning();await owner.db.insert(itAsset).values({tenantId:b.tenantId,companyId:otherCompany.id,code:'OTHER-COMPANY-DUE',assetType:'laptop',warrantyEnd:today});
  expect(await lifecycleWorklist(employee)).toEqual(actual);await owner.db.delete(lcStaff).where(eq(lcStaff.userId,userId));expect(await lifecycleWorklist(employee)).toEqual([]);
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');expect(await lifecycleWorklist(await entitledCtx(foreign))).toEqual([]);
  evidence.currentStaffAndCompanyRlsPreserved=true;evidence.revokedStaffRefused=true;evidence.foreignTenantRefused=true;
 }finally{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'lifecycle-worklist-window.json'),JSON.stringify(evidence,null,2));}
},300000);
