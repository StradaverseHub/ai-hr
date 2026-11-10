/** Personnel "export all" details read set-wise. The new reader must return exactly what the per-row
 * reader returned (the oracle below is that reader, verbatim: 1000-row slices, one per-row subject read each),
 * the export route must produce the same file from it, and its statement count must not grow with the rows.
 * Fictional at-size fixture (two sizes), driven for an HR administrator and for the fixture's scoped manager
 * (HR on two companies, Workforce view explicitly denied on a descendant). Every read runs as ai_hr_app under
 * RLS; fixture rows are written by the migration owner, like the scale fixture itself. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 session:undefined as unknown,
 mode:'set-wise' as 'set-wise'|'oracle'|'compare',
 oracle:undefined as undefined|((...args:never[])=>Promise<unknown>),
 compared:[] as {rows:unknown;fresh:unknown;oracle:unknown}[],
 inDetails:false,
}));
vi.mock('../lib/session',async importOriginal=>({...(await importOriginal<typeof import('../lib/session')>()),getSession:async()=>state.session}));
vi.mock('next/cache',()=>({revalidatePath:()=>{},revalidateTag:()=>{}}));
vi.mock('next/navigation',()=>({
 redirect:(path:string)=>{throw new Error('NEXT_REDIRECT:'+path);},notFound:()=>{throw new Error('NEXT_NOT_FOUND');},
 useRouter:()=>({refresh:()=>{},push:()=>{},replace:()=>{}}),usePathname:()=>'/admin/personnel',useSearchParams:()=>new URLSearchParams(),
}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');
 const {readFileSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const messages=JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json',import.meta.url)),'utf8'));
 return {getLocale:async()=>'en',getTranslations:async(ns?:string|{namespace?:string})=>createTranslator({locale:'en',messages,
  namespace:(typeof ns==='string'?ns:ns?.namespace) as never,onError:()=>{}})};
});
// The route reads its details through this module. 'set-wise' is the code under test; 'oracle' swaps in the
// per-row reader; 'compare' returns the set-wise details and records the oracle's in the SAME snapshot.
vi.mock('../core/personnel-list-export-details',async importOriginal=>{
 const actual=await importOriginal<typeof import('../core/personnel-list-export-details')>();
 return {...actual,readPersonnelListExportDetails:async(...args:Parameters<typeof actual.readPersonnelListExportDetails>)=>{
  if(state.mode==='oracle')return state.oracle!(...(args as never[]));
  state.inDetails=true;
  let fresh:Awaited<ReturnType<typeof actual.readPersonnelListExportDetails>>;
  try{fresh=await actual.readPersonnelListExportDetails(...args);}finally{state.inDetails=false;}
  if(state.mode==='compare')state.compared.push({rows:args[1],fresh,oracle:await state.oracle!(...(args as never[]))});
  return fresh;
 }};
});
import {isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {client as applicationClient,withTenant,type SessionContext,type Tx} from '../db/client';
import {defaultMasterColumn,runEmployeeMasterProjection,type EmployeeMasterSpec,type MasterCell} from '../lib/employee-master-report';
import type {PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
import {MasterReportAccessError,masterReportFieldsTx} from '../core/employee-master-access';
import {employeeMasterSubjectsTx} from '../core/employee-master-projection';
import {withPersonnelPresentationReadTx} from '../core/personnel-read-bounds';
import {PersonnelExportSizeError,readPersonnelListExportDetails} from '../core/personnel-list-export-details';
import {GET as exportPersonnel} from '../app/admin/personnel/export/route';
import {closeAll,migrateTestDb,owner} from './harness';
import {restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';

type Details={fields:PersonnelFieldDescriptor[];cells:Map<string,MasterCell[]>};
type Rows=readonly {employmentId:string;companyId:string}[];

/** The pre-change reader, verbatim (core/personnel-list-export-details.ts at e25edc568): the oracle. */
async function oracleDetails(ctx:SessionContext,rows:Rows,today:string,existingTx:Tx):Promise<Details>{
 const DETAILS_BATCH_SIZE=1000,MAX_DETAIL_CELLS=500_000,detailTabs=new Set(['Profile','Employment','Bank & Statutory','Payroll']);
 const companyIds=[...new Set(rows.map(row=>row.companyId))];
 const cells=new Map<string,MasterCell[]>();
 if(!companyIds.length)return {fields:[],cells};
 return withPersonnelPresentationReadTx(ctx,existingTx,async(tx,current)=>{
  let catalogue:PersonnelFieldDescriptor[];
  try{catalogue=await masterReportFieldsTx(tx,current,companyIds);}
  catch(error){if(error instanceof MasterReportAccessError)return {fields:[],cells};throw error;}
  const fields=catalogue.filter(field=>field.report.enabled&&field.grain==='single'&&
   field.scope!=='draft'&&detailTabs.has(field.tab)&&field.sensitivity!=='documents');
  if(!fields.length)return {fields,cells};
  if(rows.length*fields.length>MAX_DETAIL_CELLS)throw new PersonnelExportSizeError();
  const spec:EmployeeMasterSpec={
   v:2,asAt:today,companyIds,includeDrafts:false,
   columns:fields.map(defaultMasterColumn),
   expression:{id:'root',type:'group',logic:'and',children:[]},
   sorts:[],groups:[],
   pdf:{paper:'A4',orientation:'portrait',margins:'normal',logo:false,pageBreakGroups:false},
  };
  for(let offset=0;offset<rows.length;offset+=DETAILS_BATCH_SIZE){
   const employmentIds=rows.slice(offset,offset+DETAILS_BATCH_SIZE).map(row=>row.employmentId);
   const subjects=await employeeMasterSubjectsTx(tx,current,spec,fields,catalogue,{employmentIds});
   const projection=runEmployeeMasterProjection(spec,fields,subjects,today);
   for(const row of projection.sections[0]?.rows??[])cells.set(row.subjectId,row.cells);
  }
  return {fields,cells};
 });
}
state.oracle=oracleDetails as never;

// ── Statement trace (the same postgres.js debug hook the Personnel diagnostic uses) ───────────────────
type Statement={sql:string;details:boolean};
let recording:Statement[]|null=null;
(applicationClient.options as {debug?:unknown}).debug=(_connection:number,query:string)=>{
 if(recording)recording.push({sql:query,details:state.inDetails});
};
async function traced<T>(work:()=>Promise<T>){
 const statements:Statement[]=[];recording=statements;
 try{return {result:await work(),statements};}finally{recording=null;}
}
/** Bind lists differ only in length with the rows; everything else in a statement's text is its shape. */
const shapeOf=(sql:string)=>sql.replace(/\s+/g,' ').trim().replace(/\$\d+/g,'$').replace(/(\$[^,()\s]*)(?:, \1)*/g,'$1…');
function shapes(statements:readonly Statement[]){
 const counts=new Map<string,number>();
 for(const statement of statements){const shape=shapeOf(statement.sql);counts.set(shape,(counts.get(shape)??0)+1);}
 return Object.fromEntries([...counts].sort(([a],[b])=>a.localeCompare(b)));
}
const top=(counts:Record<string,number>)=>Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([sql,count])=>({count,sql:sql.slice(0,140)}));

// ── Details comparison ───────────────────────────────────────────────────────────────────────────────
function compareDetails(label:string,fresh:Details,oracle:Details){
 expect.soft(fresh.fields.map(field=>field.id),label+' fields').toEqual(oracle.fields.map(field=>field.id));
 expect.soft(isDeepStrictEqual(fresh.fields,oracle.fields),label+' field descriptors').toBe(true);
 const a=[...fresh.cells],b=[...oracle.cells];
 expect.soft(a.map(([id])=>id),label+' subjects in order').toEqual(b.map(([id])=>id));
 const differing=a.filter(([id,cells],index)=>!isDeepStrictEqual([id,cells],b[index])).slice(0,3)
  .map(([id,cells])=>({id,fresh:cells,oracle:oracle.cells.get(id)}));
 expect.soft(differing,label+' cells').toEqual([]);
}
/** Non-empty evidence for each set-wise source: subjects whose cell for the owner field holds a value. */
function filled(details:Details,owner:string,ownerField:string){
 const index=details.fields.findIndex(field=>field.owner===owner&&field.ownerField===ownerField);
 if(index<0)return -1;
 return [...details.cells.values()].filter(cells=>cells[index]&&!cells[index].unavailable&&cells[index].value!=null).length;
}
const EVIDENCE:[string,string][]=[['statutory','taxNumber'],['statutory','qualifyingChildren'],['statutory','childReliefAmount'],
 ['statutory','taxResidency'],['statutory','employerName'],['declaredChildRelief','under18Full'],['zakat','status'],['encashment','rawBalance'],['encashment','effectiveDays']];

// ── Workbook comparison ──────────────────────────────────────────────────────────────────────────────
async function workbookParts(bytes:Uint8Array){
 const XLSX=await import('xlsx');
 const cfb=XLSX.CFB.read(Buffer.from(bytes),{type:'buffer'}) as {FullPaths:string[];FileIndex:{type:number;content?:ArrayLike<number>}[]};
 return cfb.FullPaths.flatMap((path,index)=>cfb.FileIndex[index].type===2?[{path,content:Buffer.from(cfb.FileIndex[index].content??[])}]:[]);
}
async function exportFile(mode:'set-wise'|'oracle'|'compare'){
 state.mode=mode;
 try{
  const response=await exportPersonnel(new Request('http://x/admin/personnel/export?mode=all'));
  expect(response.status).toBe(200);
  return {bytes:new Uint8Array(await response.arrayBuffer()),disposition:response.headers.get('Content-Disposition'),type:response.headers.get('Content-Type')};
 }finally{state.mode='set-wise';}
}

// ── Fixture inputs for every set-wise source, proportional to the size ─────────────────────────────
const SEEDED=`select e.id,e.person_id,e.company_id,substr(e.employee_code,3)::int as n from employment e
 where e.tenant_id=$1::uuid and e.employee_code like 'FX%'`;
async function seedDetailInputs(f:PersonnelScaleFixture){
 const t=f.base.tenantId;
 // PCB/statutory records for every 4th person: all three child-relief modes, tax-exempt, zakat, HRDF.
 await owner.client.unsafe(`insert into employee_statutory_my(tenant_id,person_id,tax_number,tax_category,tax_circumstance,num_children,
   child_relief_mode,child_relief_table,epf_number,socso_number,bank_name,bank_account_no,zakat_active,zakat_state,zakat_method,zakat_percent,
   tax_applicability_epoch,subject_to_hrdf,disabled_individual)
  select $1::uuid,e.person_id,'SG'||lpad(e.n::text,9,'0'),case when e.n%3=0 then 2 else 1 end,
   case when e.n%20=13 then 'none' when e.n%3=0 then 'spouse_not_working' when e.n%9=1 then 'single' end,e.n%4,
   case when e.n%3=0 then 'auto' when e.n%3=1 then 'auto_table' else 'manual' end,
   case when e.n%3=1 then jsonb_build_object('under_18',jsonb_build_object('full',1+e.n%2,'half',e.n%2),'disabled',jsonb_build_object('full',e.n%2,'half',0)) end,
   'EPF'||e.n,'SOC'||e.n,'Fictional Bank','FICT-'||e.n,e.n%8=5,case when e.n%8=5 then 'Selangor' end,
   case when e.n%8=5 then 'percent_of_pcb'::zakat_method end,case when e.n%8=5 then 0.025 end,
   e.n%2,case when e.n%6=1 then true when e.n%6=3 then false end,e.n%10=9
  from (${SEEDED}) e where e.n%4=1`,[t]);
 // Family registers for most of them: eligible, aged-out, undated, shared, archived and deceased children, and a spouse.
 await owner.client.unsafe(`insert into employee_dependent(tenant_id,person_id,full_name,relationship,date_of_birth,is_student,is_deceased,
   child_tax_relief,child_relief_category,child_relief_percentage,archived_at)
  select $1::uuid,e.person_id,'Fictional '||case when k=6 then 'spouse ' else 'child ' end||e.n||'-'||k,case when k=6 then 'spouse' else 'child' end,
   case when k=3 and e.n%2=0 then null else ($2::date - ((1 + k*4 + e.n%5) * 365))::date end,
   case when k=2 then e.n%2=0 end,k=4,case when k=1 and e.n%5=0 then true end,
   case when e.n%3=0 and k<4 then (array['under_18','study_tertiary','disabled'])[1+(e.n+k)%3] end,
   case when k=2 and e.n%2=1 then 50 else 100 end,case when k=5 then now() end
  from (${SEEDED}) e cross join lateral generate_series(1,1+e.n%6) k where e.n%4=1 and e.n%3<>2`,[t,f.today]);
 // Explicit PCB selections for most of the statutory people: resolved, awaiting confirmation, stale epoch.
 await owner.client.unsafe(`insert into employment_tax_selection_my(tenant_id,employment_id,company_id,scheme,transition_state,version,source,provenance,tax_applicability_epoch)
  select $1::uuid,e.id,e.company_id,(array['resident','non_resident','knowledge_worker'])[1+e.n%3],
   case when e.n%5=0 then 'confirmation_required' else 'resolved' end,1+e.n%3,'explicit','{"reason":"fictional"}'::jsonb,
   case when e.n%7=0 then 1-e.n%2 else e.n%2 end
  from (${SEEDED}) e where e.n%4=1 and e.n%11<>4`,[t]);
 // Leave encashment snapshots for every 6th employment; every 12th has an older, unfrozen one as well.
 await owner.client.unsafe(`with requested as (
   insert into resignation_request(tenant_id,employment_id,person_id,last_working_day,status,created_at)
   select $1::uuid,e.id,e.person_id,$2::date + 10,'accepted',now() - make_interval(days => d)
   from (${SEEDED}) e cross join lateral (values (3),(40)) v(d) where e.n%6=2 and (v.d=3 or e.n%12=2)
   returning id,employment_id,created_at)
  insert into leave_encashment_snapshot(tenant_id,employment_id,resignation_request_id,leave_type_id,balance_days,encashable_days,
   calculated_as_of,status,override_days,override_reason,created_at)
  select $1::uuid,r.employment_id,r.id,$3::uuid,(5 + extract(day from r.created_at)::int % 9)::numeric(6,2),
   (3 + extract(day from r.created_at)::int % 5)::numeric(6,2),$2::date - 1,
   case when r.created_at < now() - interval '10 days' then 'unfrozen' else 'frozen' end::leave_encashment_status,
   case when extract(day from r.created_at)::int % 2 = 0 then 2.5 end,case when extract(day from r.created_at)::int % 2 = 0 then 'Fictional override' end,
   r.created_at
  from requested r`,[t,f.today,f.base.annualLeaveTypeId]);
 const [counts]=await owner.client<{statutory:number;dependents:number;selections:number;snapshots:number}[]>`select
  (select count(*)::int from employee_statutory_my where tenant_id=${t}::uuid) as statutory,
  (select count(*)::int from employee_dependent where tenant_id=${t}::uuid) as dependents,
  (select count(*)::int from employment_tax_selection_my where tenant_id=${t}::uuid) as selections,
  (select count(*)::int from leave_encashment_snapshot where tenant_id=${t}::uuid) as snapshots`;
 for(const value of Object.values(counts))expect(value).toBeGreaterThan(Math.floor(f.count/40));
 for(const table of ['employee_statutory_my','employee_dependent','employment_tax_selection_my','leave_encashment_snapshot'])
  await owner.client.unsafe('analyze '+table);
 return counts;
}
/** Current employments with no assignment history at all: no dated proof, so the projection resolves
 * today's company through companyOnDate. Proportional to the size. */
async function seedUnprovenEmployments(f:PersonnelScaleFixture){
 const t=f.base.tenantId,count=Math.max(4,Math.floor(f.count/50)),companies=[f.companies.a,f.companies.b,f.companies.c,f.companies.d];
 const prefix=randomUUID().slice(0,24);
 await owner.client.unsafe(`insert into person(id,tenant_id,full_name,primary_email)
  select ('${prefix}'||lpad(n::text,12,'0'))::uuid,$1::uuid,'Fictional unplaced '||n,'fictional.unplaced.'||n||'@example.invalid' from generate_series(1,$2::int) n`,[t,count]);
 await owner.client.unsafe(`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select $1::uuid,('${prefix}'||lpad(n::text,12,'0'))::uuid,($3::uuid[])[1+n%4],'FY'||lpad(n::text,6,'0'),date '2021-03-01' + n
  from generate_series(1,$2::int) n`,[t,count,companies]);
 return count;
}
async function employmentRows(f:PersonnelScaleFixture,companyIds:readonly string[]):Promise<{employmentId:string;companyId:string;terminated:boolean;unproven:boolean}[]>{
 return (await owner.client<{employmentId:string;companyId:string;terminated:boolean;unproven:boolean}[]>`select id as "employmentId",company_id as "companyId",
  terminated_on is not null as terminated,employee_code like 'FY%' as unproven
  from employment where tenant_id=${f.base.tenantId}::uuid and company_id=any(${companyIds as string[]}::uuid[])
  order by employee_code`).map(row=>({...row}));
}

/** The larger size puts both roles' exports across the oracle's 1000-row slices. */
const SIZES=[240,2600] as const;
type RoleRun={routeTrips:number;routeShapes:Record<string,number>;detailTrips:number;detailShapes:Record<string,number>;
 directTrips:number;directShapes:Record<string,number>;rows:number;evidence:Record<string,number>};

describe('Personnel export details: set-wise reader',()=>{
 beforeAll(migrateTestDb,120_000);
 afterAll(async()=>{try{await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

 it('matches the per-row reader and file byte for byte, with a statement count that does not grow with the rows',async()=>{
  const runs:Record<string,Record<string,RoleRun>>={};
  for(const size of SIZES){
   const fixture=await seedPersonnelScaleFixture(size);
   const inputs=await seedDetailInputs(fixture);
   const roles={admin:{ctx:fixture.admin,companies:Object.values(fixture.companies)},
    manager:{ctx:fixture.manager,companies:fixture.managerVisibleCompanies}} as const;
   runs[size]={};
   for(const [role,{ctx}] of Object.entries(roles)){
    state.session=ctx;
    // (a) In the route's own snapshot: set-wise details equal the per-row oracle's.
    state.compared=[];
    const compared=await exportFile('compare');
    expect(state.compared).toHaveLength(1);
    const {rows,fresh,oracle}=state.compared[0] as {rows:Rows;fresh:Details;oracle:Details};
    compareDetails(`${size}/${role}/route`,fresh,oracle);
    expect.soft(rows.length,'the larger export spans more than one of the oracle\'s slices').toBeGreaterThan(size===SIZES[1]?1000:50);
    const terminated=new Set((await employmentRows(fixture,roles[role as keyof typeof roles].companies)).filter(row=>row.terminated).map(row=>row.employmentId));
    const terminatedWithDetails=rows.filter(row=>terminated.has(row.employmentId)&&fresh.cells.has(row.employmentId)).length;
    expect.soft(terminatedWithDetails,'terminated employments are exported with details').toBeGreaterThan(0);
    console.info('[personnel-export-bulk] route '+JSON.stringify({size,role,rows:rows.length,withDetails:fresh.cells.size,terminatedWithDetails,fields:fresh.fields.length}));
    const evidence=Object.fromEntries(EVIDENCE.map(([owner,field])=>[owner+'.'+field,filled(fresh,owner,field)]));
    for(const [key,count] of Object.entries(evidence))expect.soft(count,`${size}/${role} ${key} is read and filled`).toBeGreaterThan(0);

    // (b) The file: deterministic for one database state, and identical to the file built from the oracle.
    const first=await traced(()=>exportFile('set-wise'));
    const second=await exportFile('set-wise');
    const fromOracle=await exportFile('oracle');
    const deterministic=Buffer.from(first.result.bytes).equals(Buffer.from(second.bytes));
    console.info('[personnel-export-bulk] xlsx '+JSON.stringify({size,role,bytes:first.result.bytes.length,deterministic,
     identical:Buffer.from(first.result.bytes).equals(Buffer.from(fromOracle.bytes)),
     sha256:createHash('sha256').update(first.result.bytes).digest('hex'),oracleSha256:createHash('sha256').update(fromOracle.bytes).digest('hex')}));
    expect.soft(deterministic,'XLSX.write is deterministic for one database state').toBe(true);
    expect.soft(Buffer.from(first.result.bytes).equals(Buffer.from(fromOracle.bytes)),'xlsx bytes equal the oracle file').toBe(true);
    expect.soft(Buffer.from(compared.bytes).equals(Buffer.from(fromOracle.bytes))).toBe(true);
    expect.soft(first.result.disposition).toBe(fromOracle.disposition);expect.soft(first.result.type).toBe(fromOracle.type);
    const [parts,oracleParts]=await Promise.all([workbookParts(first.result.bytes),workbookParts(fromOracle.bytes)]);
    expect.soft(parts.map(part=>part.path)).toEqual(oracleParts.map(part=>part.path));
    expect.soft(parts.filter((part,index)=>!part.content.equals(oracleParts[index].content)).map(part=>part.path),'uncompressed parts').toEqual([]);
    const sheet=parts.find(part=>/worksheets\/sheet1\.xml$/.test(part.path));
    expect.soft(sheet?.content.toString('utf8')).toContain('<sheetData>');

    // (c) Statements of the set-wise export (the details reader's are marked).
    const detailStatements=first.statements.filter(statement=>statement.details);
    runs[size][role]={routeTrips:first.statements.length,routeShapes:shapes(first.statements),detailTrips:detailStatements.length,
     detailShapes:shapes(detailStatements),directTrips:0,directShapes:{},rows:rows.length,evidence};
   }

   // Direct reads over every employment of the role's companies, including current ones with no dated
   // company proof, terminated ones, and (for the manager) the explicitly denied descendant's.
   const unproven=await seedUnprovenEmployments(fixture);
   const direct=async(label:string,ctx:SessionContext,rows:Rows,record?:RoleRun)=>withTenant(ctx,async tx=>{
    const fresh=record?await traced(()=>readPersonnelListExportDetails(ctx,rows,fixture.today,tx)):{result:await readPersonnelListExportDetails(ctx,rows,fixture.today,tx),statements:[]};
    const oracle=await oracleDetails(ctx,rows,fixture.today,tx);
    compareDetails(label,fresh.result,oracle);
    if(record){record.directTrips=fresh.statements.length;record.directShapes=shapes(fresh.statements);}
    return fresh.result;
   },{readOnlySnapshot:true});
   for(const [role,{ctx,companies}] of Object.entries(roles)){
    const rows=await employmentRows(fixture,companies);
    const details=await direct(`${size}/${role}/direct`,ctx,rows,runs[size][role]);
    const unplaced=rows.filter(row=>!details.cells.has(row.employmentId)).length;
    const unprovenWithDetails=rows.filter(row=>row.unproven&&details.cells.has(row.employmentId)).length;
    expect.soft(unprovenWithDetails,`${size}/${role} current employments without dated proof resolve today's company`).toBeGreaterThan(0);
    console.info('[personnel-export-bulk] direct '+JSON.stringify({size,role,rows:rows.length,unprovenSeeded:unproven,unprovenWithDetails,withoutCells:unplaced}));
   }
   const descendant=await employmentRows(fixture,[fixture.companies.b,fixture.companies.c,fixture.companies.d]);
   const widened=await direct(`${size}/manager/with-denied-descendant`,fixture.manager,descendant);
   console.info('[personnel-export-bulk] descendant '+JSON.stringify({size,rows:descendant.length,fields:widened.fields.length,withDetails:widened.cells.size}));
   console.info('[personnel-export-bulk] inputs '+JSON.stringify({size,...inputs,unproven}));
  }

  // The same statements at both sizes: count and every statement shape (bind-list lengths aside).
  for(const role of ['admin','manager']){
   const [small,large]=[runs[SIZES[0]][role],runs[SIZES[1]][role]];
   console.info('[personnel-export-bulk] statements '+JSON.stringify({role,
    sizes:SIZES,route:[small.routeTrips,large.routeTrips],details:[small.detailTrips,large.detailTrips],direct:[small.directTrips,large.directTrips],
    rows:[small.rows,large.rows],evidence:[small.evidence,large.evidence],mostRepeated:top(large.detailShapes)}));
   expect.soft(large.detailShapes,role+' details statements by shape').toEqual(small.detailShapes);
   expect.soft(large.directShapes,role+' direct details statements by shape').toEqual(small.directShapes);
   expect.soft(large.detailTrips).toBe(small.detailTrips);
   expect.soft(large.directTrips).toBe(small.directTrips);
   expect.soft(large.routeShapes,role+' export statements by shape').toEqual(small.routeShapes);
   expect.soft(large.routeTrips,role+' export statements').toBe(small.routeTrips);
   // Nothing repeats per row: no shape occurs anywhere near once per exported row.
   expect.soft(Math.max(...Object.values(large.detailShapes))).toBeLessThan(Math.min(small.rows,100));
  }
 },900_000);
});
