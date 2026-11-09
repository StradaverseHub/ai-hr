/** Native full-authorized count and bounded detail hydration for the Reports hub. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {listEmployeeMasterReports,readEmployeeMasterReportHub,saveEmployeeMasterReport} from '../core/employee-master-reports';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {defaultMasterColumn,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase} from './harness';
let PAGE_CTX:SessionContext,PAGE_SCOPE:string[];
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:PAGE_CTX,scopeIds:PAGE_SCOPE})}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string,values?:Record<string,unknown>)=>values?.count!==undefined?key+':'+values.count:key),getLocale:async()=>'en'}));
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.restoreAllMocks());
it('keeps all authorized count/preview/toast/field boundaries while hydrating only displayed details',async()=>{
 await resetDb();const b=await seedBase(),ctx={...adminCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 const spec:EmployeeMasterSpec={v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const saved:Awaited<ReturnType<typeof saveEmployeeMasterReport>>[]=[];
 for(let i=0;i<40;i++)saved.push(await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional retained definition '+String(i).padStart(3,'0'),description:'Synthetic retained report metadata',sharedRoleIds:[],spec}));
 const nativeBegin=client.begin;let active=false,counts:Record<string,number>={};const add=(key:string)=>{counts[key]=(counts[key]??0)+1;};
 vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(arg=>typeof arg==='function'),callback=args[index] as(native:typeof client)=>unknown;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return(...query:unknown[])=>{
    if(active&&typeof query[0]==='string'){const text=query[0].replace(/\s+/g,' ').trim().toLowerCase();add('roundTrips');if(text==='select app.is_admin() as admin')add('detailAdminReads');if(text.includes('from app_user u left join person p'))add('detailOwnerReads');if(text.includes('from "custom_report_schedule"'))add('detailScheduleReads');}
    return Reflect.apply(target.unsafe,target,query);
   };return Reflect.get(target,key,receiver);
  }}));return Reflect.apply(nativeBegin,client,args);
 }) as typeof client.begin);
 const measure=async<T>(fn:()=>Promise<T>)=>{counts={};active=true;const start=performance.now();try{return {value:await fn(),elapsedMs:performance.now()-start,counts:{...counts}};}finally{active=false;}};
 const original=await measure(()=>listEmployeeMasterReports(ctx,[b.companyId],{all:true})),candidate=await measure(()=>readEmployeeMasterReportHub(ctx,[b.companyId],saved[0].id)),warm=await measure(()=>readEmployeeMasterReportHub(ctx,[b.companyId],saved[0].id)),restored=await measure(()=>listEmployeeMasterReports(ctx,[b.companyId],{all:true}));
 expect(original.value).toHaveLength(40);expect(candidate.value.total).toBe(40);expect(candidate.value.reports).toEqual(original.value.slice(0,5));expect(candidate.value.savedReport).toEqual(original.value.find(row=>row.id===saved[0].id));expect(warm.value).toEqual(candidate.value);expect(restored.value).toEqual(original.value);
 expect(candidate.value.reports.map(row=>row.name)).toEqual([39,38,37,36,35].map(i=>'Fictional retained definition '+String(i).padStart(3,'0')));
 for(const key of ['detailAdminReads','detailOwnerReads','detailScheduleReads']){expect(original.counts[key],key).toBe(40);expect(candidate.counts[key],key).toBe(6);}
 expect(candidate.counts.roundTrips).toBeLessThan(original.counts.roundTrips);
 for(const id of [randomUUID(),'not-a-uuid','',saved[0].id.toUpperCase()]){const result=await readEmployeeMasterReportHub(ctx,[b.companyId],id);expect(result.total).toBe(40);expect(result.savedReport).toBeUndefined();expect(result.reports).toEqual(original.value.slice(0,5));}
 expect(await readEmployeeMasterReportHub(ctx,[randomUUID()],saved[0].id)).toEqual({reports:[],total:0,savedReport:undefined});
 const foreign=await seedBase();expect(await readEmployeeMasterReportHub({...adminCtx(foreign),personId:null},[foreign.companyId],saved[0].id)).toEqual({reports:[],total:0,savedReport:undefined});
 const salary=PERSONNEL_FIELDS.find(field=>field.owner==='compensation'&&field.ownerField==='basicSalary')!;
 const restricted=await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional restricted newest definition',description:'Must not enter preview or count',sharedRoleIds:[],spec:{...spec,columns:[defaultMasterColumn(salary)]}});
 await setPayrollPermissionGrant(ctx,{companyId:b.companyId,permissionKey:'report.read.compensation',role:'hr_admin',allowed:false});
 const revoked=await readEmployeeMasterReportHub(ctx,[b.companyId],restricted.id);expect(revoked.total).toBe(40);expect(revoked.savedReport).toBeUndefined();expect(revoked.reports).toEqual(original.value.slice(0,5));
 // Execute the real server page with native data; inspect its rendered element tree, not source text.
 PAGE_CTX=ctx;PAGE_SCOPE=[b.companyId];const page=await(await import('../app/reports/page')).default({searchParams:Promise.resolve({cat:'master',saved:saved[0].id})});
 const nodes:unknown[]=[];const visit=(node:unknown)=>{if(Array.isArray(node)){node.forEach(visit);return;}if(!node||typeof node!=='object')return;nodes.push(node);const props=(node as {props?:{children?:unknown}}).props;if(props)visit(props.children);};visit(page);
 expect(nodes.some(node=>{const props=(node as {props?:Record<string,unknown>}).props;return props?.href==='/reports/employee-master'&&props['aria-label']==='viewAllCountLabel:40'&&props.children==='viewAllCount:40';})).toBe(true);
 expect(nodes.some(node=>{const reports=(node as {props?:{reports?:unknown[]}}).props?.reports;return reports?.length===5&&JSON.stringify(reports)===JSON.stringify(original.value.slice(0,5));})).toBe(true);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-master-report-preview.json'),JSON.stringify({kind:'NATIVE_MASTER_HUB_COUNTED_SUMMARY',releaseEligible:false,retainedDefinitions:40,authorizedTotal:40,previewRows:5,savedOutsidePreview:true,original:{elapsedMs:original.elapsedMs,counts:original.counts},candidate:{elapsedMs:candidate.elapsedMs,counts:candidate.counts},warm:{elapsedMs:warm.elapsedMs,counts:warm.counts},restored:{elapsedMs:restored.elapsedMs,counts:restored.counts},fullLibraryApiUnchanged:true,fieldRevocationAndForeignScopePreserved:true,actualPageFullCountLabelVerified:true,providerCalls:0,limitations:'Per-definition authorization remains complete; no permission/result cache, HTTP/browser/500-user or million-definition acceptance.'},null,2));
},300000);
