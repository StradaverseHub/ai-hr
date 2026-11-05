/** Native definition preview/lookup contract; no report execution or provider delivery. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {listEmployeeMasterReports,saveEmployeeMasterReport} from '../core/employee-master-reports';
import {defaultMasterColumn,type EmployeeMasterSpec} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the existing first five authorized definitions and resolves one saved toast without reading every template',async()=>{
 await resetDb();const b=await seedBase(),ctx={...adminCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 const spec:EmployeeMasterSpec={v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(code)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const saved=[];for(let i=0;i<40;i++)saved.push(await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional retained definition '+String(i).padStart(3,'0'),description:'Synthetic retained report metadata',sharedRoleIds:[],spec}));
 const timed=async(options:Parameters<typeof listEmployeeMasterReports>[2])=>{const start=performance.now(),rows=await listEmployeeMasterReports(ctx,[b.companyId],options);return{rows,elapsedMs:performance.now()-start};};
 const original=await timed({all:true}),preview=await timed({}),lookup=await timed({all:true,...{id:saved[0].id}});
 const evidence:Record<string,unknown>={kind:'NATIVE_MASTER_REPORT_PREVIEW_COMPONENT',releaseEligible:false,retainedDefinitions:40,fullRows:original.rows.length,previewRows:preview.rows.length,lookupRows:lookup.rows.length,fullMs:original.elapsedMs,previewMs:preview.elapsedMs,lookupMs:lookup.elapsedMs,providerCalls:0,limitations:'No HTTP/browser/500-user or million-definition acceptance; full library remains unchanged.'};
 try{
  expect(original.rows).toHaveLength(40);expect(preview.rows).toEqual(original.rows.slice(0,5));
  expect(preview.rows.map(row=>row.name)).toEqual([39,38,37,36,35].map(i=>'Fictional retained definition '+String(i).padStart(3,'0')));
  expect(lookup.rows,'A saved toast lookup must validate only the exact matching definition').toEqual([original.rows.find(row=>row.id===saved[0].id)]);
  for(const id of [randomUUID(),'not-a-uuid',''])expect(await listEmployeeMasterReports(ctx,[b.companyId],{...{id}})).toEqual([]);
  expect(await listEmployeeMasterReports(ctx,[randomUUID()],{...{id:saved[0].id}})).toEqual([]);
  const foreign=await seedBase();expect(await listEmployeeMasterReports({...adminCtx(foreign),personId:null},[foreign.companyId],{...{id:saved[0].id}})).toEqual([]);
  expect((await listEmployeeMasterReports(ctx,[b.companyId],{all:true})).map(row=>row.id)).toEqual(original.rows.map(row=>row.id));evidence.exactPreviewAndLookup=true;
 }finally{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-master-report-preview.json'),JSON.stringify(evidence,null,2));}
},300000);
