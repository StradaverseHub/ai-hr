import { todayInKualaLumpur } from '../lib/hr-date';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as s from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { bulkSaveLabels, createJobGrade, type LabelCreateInput, type LabelUpdateInput } from './admin';
import { createProfileOption } from './profile-options';
import { visibleLabelIdsCondition, labelMaintenanceCondition, SYSTEM_LABEL_MAINTENANCE_LIMIT, boundedLabelMaintenanceRows, lockLabelCriteriaTx, existingSystemLabelImportKeysTx } from './system-labels';
import { createGradeGroup } from '../packs/leave/service';
import { EMPLOYMENT_LABEL_CATEGORIES, LABEL_IMPORT_DEFINITIONS, ORGANISATION_LABEL_KINDS,
  ORGANISATION_LABEL_COLUMNS, type OrganisationLabelKind, type LabelImportMode,
  type LabelImportRow, type LabelImportPreview, type LabelImportPreviewRow } from '../lib/system-label-definition';
import { readSystemLabelWorkbook, buildSystemLabelWorkbook, systemLabelExportId, systemLabelErrorWorkbook } from '../lib/system-label-workbook';

const lower = (v: string) => v.toLowerCase();
const list = (v: string) => [...new Set(v.split(';').map(x => x.trim()).filter(Boolean))].sort();
const whole = (v: string) => { if (v && !/^-?\d{1,9}$/.test(v)) throw new Error('Rank and Sort Order must be whole numbers.'); return Number(v || 0); };
const same = (a: Record<string,string>, b: Record<string,string>) => JSON.stringify(Object.keys(a).sort().map(key=>[key,a[key]])) === JSON.stringify(Object.keys(b).sort().map(key=>[key,b[key]]));
type Org = { kind: OrganisationLabelKind; id: string; companyId: string; archived: boolean;
  values: Record<string, string>; original: LabelUpdateInput };

type Catalogue = {
  companies:{id:string;name:string;archived:Date|null;writable:boolean}[];
  orgs:Org[];options:(typeof s.profileOption.$inferSelect)[];grades:(typeof s.jobGrade.$inferSelect)[];
  groups:(typeof s.gradeGroup.$inferSelect)[];members:(typeof s.gradeGroupMember.$inferSelect)[];
  employees:{id:string;code:string|null;companyId:string;name:string;active:boolean}[];groupAdmin:boolean;
};
const companyCell=(companies:Catalogue['companies'],id:string)=>{const co=companies.find(x=>x.id===id);return co&&companies.filter(x=>x.name===co.name).length===1?co.name:id;};
async function catalogue(tx: Tx): Promise<Catalogue> {
  const permission = await tx.execute(sql`select app.is_admin() as allowed, app.is_group_admin() as global`) as unknown as {allowed:boolean;global:boolean}[];
  if (!permission[0]?.allowed) throw new Error('Only an administrator may import System Labels.');
  const [companies, departments, positions, costs, units, options, grades, groups, members, assignments, employees] = await Promise.all([
    tx.select({ id:s.company.id,name:s.company.legalName, archived:s.company.archivedAt,
      writable:sql<boolean>`app.is_admin_for(${s.company.id})` }).from(s.company).where(sql`app.is_admin_for(${s.company.id}) or exists(select 1 from department where department.company_id=${s.company.id} and ${labelMaintenanceCondition(s.department,'department')}) or exists(select 1 from "position" where "position".company_id=${s.company.id} and ${labelMaintenanceCondition(s.position,'position')}) or exists(select 1 from cost_center where cost_center.company_id=${s.company.id} and ${labelMaintenanceCondition(s.costCenter,'cost_center')}) or exists(select 1 from business_unit where business_unit.company_id=${s.company.id} and ${labelMaintenanceCondition(s.businessUnit,'business_unit')}) or exists(select 1 from label_company_assignment lca where lca.company_id=${s.company.id} and (
   exists(select 1 from department where department.id=lca.label_id and lca.label_kind='department' and ${labelMaintenanceCondition(s.department,'department')}) or
   exists(select 1 from "position" where "position".id=lca.label_id and lca.label_kind='position' and ${labelMaintenanceCondition(s.position,'position')}) or
   exists(select 1 from cost_center where cost_center.id=lca.label_id and lca.label_kind='cost_center' and ${labelMaintenanceCondition(s.costCenter,'cost_center')}) or
   exists(select 1 from business_unit where business_unit.id=lca.label_id and lca.label_kind='business_unit' and ${labelMaintenanceCondition(s.businessUnit,'business_unit')})
  ))`).orderBy(asc(s.company.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
    tx.select().from(s.department).where(labelMaintenanceCondition(s.department,'department')).orderBy(asc(s.department.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1), tx.select().from(s.position).where(labelMaintenanceCondition(s.position,'position')).orderBy(asc(s.position.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
    tx.select().from(s.costCenter).where(labelMaintenanceCondition(s.costCenter,'cost_center')).orderBy(asc(s.costCenter.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1), tx.select().from(s.businessUnit).where(labelMaintenanceCondition(s.businessUnit,'business_unit')).orderBy(asc(s.businessUnit.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
    tx.select().from(s.profileOption).orderBy(asc(s.profileOption.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1), tx.select().from(s.jobGrade).orderBy(asc(s.jobGrade.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
    tx.select().from(s.gradeGroup).orderBy(asc(s.gradeGroup.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1), tx.select().from(s.gradeGroupMember).orderBy(asc(s.gradeGroupMember.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
    tx.select().from(s.labelCompanyAssignment).where(sql`exists(select 1 from department where department.id=${s.labelCompanyAssignment.labelId} and ${s.labelCompanyAssignment.labelKind}='department' and ${labelMaintenanceCondition(s.department,'department')}) or exists(select 1 from "position" where "position".id=${s.labelCompanyAssignment.labelId} and ${s.labelCompanyAssignment.labelKind}='position' and ${labelMaintenanceCondition(s.position,'position')}) or exists(select 1 from cost_center where cost_center.id=${s.labelCompanyAssignment.labelId} and ${s.labelCompanyAssignment.labelKind}='cost_center' and ${labelMaintenanceCondition(s.costCenter,'cost_center')}) or exists(select 1 from business_unit where business_unit.id=${s.labelCompanyAssignment.labelId} and ${s.labelCompanyAssignment.labelKind}='business_unit' and ${labelMaintenanceCondition(s.businessUnit,'business_unit')})`).orderBy(asc(s.labelCompanyAssignment.id)).limit(50_001),
    tx.select({id:s.employment.id,code:s.employment.employeeCode,companyId:s.employment.companyId,name:s.person.fullName,active:sql<boolean>`(${s.employment.terminatedOn} is null or ${s.employment.terminatedOn} >= ${todayInKualaLumpur()}::date) and ${s.employment.hiredOn} <= ${todayInKualaLumpur()}::date`})
      .from(s.employment).innerJoin(s.person,eq(s.person.id,s.employment.personId)).where(sql`app.is_admin_for(${s.employment.companyId})`).orderBy(asc(s.employment.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1),
  ]);
  for(const rows of [companies,departments,positions,costs,units,options,grades,groups,members,employees])boundedLabelMaintenanceRows(rows);
  if(assignments.length>50_000)throw new Error('System Labels criteria exceed the supported workbook size.');
  const orgs: Org[] = [];
  const normalise = (kind: OrganisationLabelKind, rows: (typeof departments[number] | typeof positions[number] | typeof costs[number] | typeof units[number])[]) => {
    for (const r of rows) {
      const field = (key: string) => String((r as unknown as Record<string,unknown>)[key] ?? '');
      const shared = assignments.filter(a => a.labelId === r.id && a.labelKind === kind).map(a => a.companyId).sort();
      const values: Record<string,string> = { Company:companyCell(companies,r.companyId), Criteria:r.isGlobal?'global':'companies', 'Criteria Companies':r.isGlobal?'':shared.map(id=>companyCell(companies,id)).sort().join(';') };
      for (const c of ORGANISATION_LABEL_COLUMNS[kind]) values[{code:'Code',label:'Label',description:'Description'}[c.headerKey]] = field(c.field);
      if (kind === 'department' || kind === 'business_unit') values['Head Employee Code'] = employees.find(e => e.id === field('headEmploymentId'))?.code ?? '';
      orgs.push({kind,id:r.id,companyId:r.companyId,archived:r.archivedAt!=null,values,
        original:{key:r.id,id:r.id,name:field('name'),title:field('title'),code:field('code'),label:field('label'),
          description:field('description'),jobFamily:field('jobFamily'),...(['department','business_unit'].includes(kind)?{headEmploymentId:field('headEmploymentId')||null}:{})} });
    }
  };
  normalise('department',departments);normalise('position',positions);normalise('cost_center',costs);normalise('business_unit',units);
  return {companies,orgs,options,grades,groups,members,employees,groupAdmin:permission[0].global};
}

export function downloadSystemLabelTemplate(ctx: SessionContext): Promise<Buffer> {
  return withTenant(ctx,async tx => {
    const c=await catalogue(tx);
    return buildSystemLabelWorkbook({kinds:LABEL_IMPORT_DEFINITIONS.map(d=>d.kind),references:{companies:c.companies.filter(x=>x.writable&&!x.archived).map(x=>[x.name,x.id]),
      grades:c.grades.filter(x=>!x.archivedAt).map(x=>[x.code,x.name]),
      employees:c.employees.filter(x=>c.companies.some(co=>co.id===x.companyId&&co.writable)&&x.code).map(x=>[x.code!,x.companyId,x.name])}});
  });
}

export type SystemLabelExportSelection={companyIds:string[];kinds:string[];includeInactive:boolean};
const fingerprint=(values:Record<string,string>)=>createHash('sha256').update(JSON.stringify(Object.keys(values).sort().map(key=>[key,values[key]]))).digest('hex');
const rowKey=(sheet:string,values:Record<string,string>)=>JSON.stringify([sheet,values.Company??'',values.Code??values.Name??'']);
type ExportRow={id:string;key:string;hash:string};
type ExportAudit={version:1;rows:ExportRow[];exportedAt:string};
function exportRows(c:Catalogue,includeInactive:boolean) {
 const rows:{sheet:string;id:string;values:Record<string,string>;active:boolean}[]=[];
 for(const r of c.orgs)if(includeInactive||!r.archived)rows.push({sheet:r.kind,id:r.id,values:{...r.values},active:!r.archived});
 for(const r of c.options)if((EMPLOYMENT_LABEL_CATEGORIES as readonly string[]).includes(r.category)&&(includeInactive||r.isActive))rows.push({sheet:r.category,id:r.id,values:{Code:r.value,Label:r.label,Description:r.description??'','Sort Order':String(r.sortOrder)},active:r.isActive});
 for(const r of c.grades)if(includeInactive||!r.archivedAt)rows.push({sheet:'grades',id:r.id,values:{Code:r.code,Label:r.name,Description:r.description??'',Rank:String(r.rank)},active:!r.archivedAt});
 for(const r of c.groups)if(includeInactive||!r.archivedAt)rows.push({sheet:'grade_groups',id:r.id,values:{Name:r.name,'Grade Codes':c.members.filter(m=>m.gradeGroupId===r.id).map(m=>c.grades.find(g=>g.id===m.gradeId)?.code??'').sort().join(';')},active:!r.archivedAt});
 return rows;
}
export async function downloadSystemLabelsWithData(ctx:SessionContext,p:SystemLabelExportSelection):Promise<Buffer> {
 return withTenant(ctx,async tx=>{
  const c=await catalogue(tx),companyIds=[...new Set(p.companyIds)],kinds=[...new Set(p.kinds)];
  if(!companyIds.length||companyIds.some(id=>!c.companies.some(co=>co.id===id&&co.writable&&!co.archived))||!kinds.length||kinds.some(kind=>!LABEL_IMPORT_DEFINITIONS.some(d=>d.kind===kind)))throw new Error('Select accessible companies and supported lists.');
  const visible=new Set<string>();
  for(const kind of ORGANISATION_LABEL_KINDS){
   const table={department:s.department,position:s.position,cost_center:s.costCenter,business_unit:s.businessUnit}[kind];
   for(const row of await tx.select({id:table.id}).from(table).where(visibleLabelIdsCondition(table,kind,companyIds)))visible.add(row.id);
  }
  const rows=exportRows(c,p.includeInactive).filter(r=>kinds.includes(r.sheet)&&(!(ORGANISATION_LABEL_KINDS as readonly string[]).includes(r.sheet)||visible.has(r.id)));
  const data:Record<string,Record<string,string>[]>=Object.fromEntries(kinds.map(kind=>[kind,[]]));
  for(const row of rows)data[row.sheet].push({...row.values,Status:row.active?'Active':'Archived / Inactive'});
  const id=randomUUID();
  const bytes=await buildSystemLabelWorkbook({kinds,rows:data,includeStatus:p.includeInactive,exportId:id,references:{
   companies:c.companies.filter(co=>!co.archived&&(co.writable||rows.some(r=>r.values.Company===co.name||r.values.Company===co.id))).map(co=>[co.name,co.id]),
   grades:c.grades.filter(g=>!g.archivedAt).map(g=>[g.code,g.name]),
   employees:c.employees.filter(e=>e.active&&e.code&&c.companies.some(co=>co.id===e.companyId&&co.writable)).map(e=>[e.code!,e.companyId,e.name])}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'system-label-export',aggregateId:id,eventType:'system-labels.exported',actor:actorOf(ctx),payload:{version:1,companyIds,kinds,includeInactive:p.includeInactive,count:rows.length,rows:rows.map(r=>({id:r.id,key:rowKey(r.sheet,r.values),hash:fingerprint(r.values)}))}});
  return bytes;
 });
}
async function readExportAudit(tx:Tx,ctx:SessionContext,exportId:string|null):Promise<ExportAudit|null> {
 if(!exportId)return null;
 const [event]=await tx.select({payload:s.domainEvent.payload,occurredAt:s.domainEvent.occurredAt}).from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,ctx.tenantId),eq(s.domainEvent.aggregateId,exportId),eq(s.domainEvent.eventType,'system-labels.exported'),ctx.userId?eq(s.domainEvent.actorId,ctx.userId):sql`false`)).limit(1);
 if(!event)throw new Error('This export is unavailable to this user. Download a new workbook.');
 const payload=event.payload as unknown as Partial<ExportAudit>;
 if(payload.version!==1||!Array.isArray(payload.rows)||payload.rows.length>7000||payload.rows.some(r=>typeof r.id!=='string'||typeof r.key!=='string'||typeof r.hash!=='string'))throw new Error('Export history is invalid. Download a new workbook.');
 return {version:1,rows:payload.rows,exportedAt:event.occurredAt.toISOString()};
}

const existingCodeMessage = 'This code already exists in this category. No existing record will be changed. Edit it on the System Labels page.';
/** Import intent is server-owned. Legacy mode arguments and export receipts confer no update right. */
async function analyse(tx: Tx, ctx: SessionContext, rows: LabelImportRow[], audit: ExportAudit|null, selectedKeys?: string[]): Promise<{preview:LabelImportPreview;writes:(()=>Promise<unknown>)[]}> {
  const c=await catalogue(tx), output:LabelImportPreviewRow[]=[], writes:{key:string;apply:()=>Promise<unknown>;org?:{kind:OrganisationLabelKind;create:LabelCreateInput}}[]=[];
  const allowedKeys=new Set(rows.map(r=>r.sheet+':'+r.row));
  if(selectedKeys&&(new Set(selectedKeys).size!==selectedKeys.length||selectedKeys.some(k=>!allowedKeys.has(k))))throw new Error('Invalid row selection.');
  const selected=selectedKeys?new Set(selectedKeys):null;
  const proposals=rows.filter(row=>(ORGANISATION_LABEL_KINDS as readonly string[]).includes(row.sheet)&&!!row.values.Code).map(row=>({key:row.sheet+':'+row.row,kind:row.sheet as OrganisationLabelKind,code:row.values.Code}));
  // Only existence is returned: hidden companies, identities and values never enter this catalogue.
  const incumbentKeys=new Set(await existingSystemLabelImportKeysTx(tx,ctx.tenantId,proposals));
  const seen=new Map<string,Record<string,string>>(), names=new Set<string>(), memberClaims=new Set<string>();
  for(const row of rows){
    const key=row.sheet+':'+row.row;
    const result:LabelImportPreviewRow={...row,outcome:'error',message:'',before:null,after:{...row.values},selected:selected?selected.has(key):true};
    output.push(result);
    try {
      const definition=LABEL_IMPORT_DEFINITIONS.find(d=>d.kind===row.sheet);
      if(!definition)throw new Error('Unsupported label category. This worksheet was not imported.');
      const v=result.after;
      const requireValue=(field:string)=>{if(!v[field])throw new Error(`${field} is required.`);return v[field];};
      const identify=(identity:string)=>{
        const previous=seen.get(identity);
        if(previous){result.reason=same(previous,v)?'duplicate':'conflicting';result.outcome='skip';result.selected=false;result.message=same(previous,v)?'Duplicate code in this workbook; only the first valid row can be added.':'Conflicting code in this workbook; this later row is skipped.';return false;}
        seen.set(identity,{...v});return true;
      };
      const add=(apply:()=>Promise<unknown>,org?:{kind:OrganisationLabelKind;create:LabelCreateInput})=>{
        result.outcome='add';result.message='Valid new code.';writes.push({key,apply,org});
      };
      if((ORGANISATION_LABEL_KINDS as readonly string[]).includes(row.sheet)){
        const kind=row.sheet as OrganisationLabelKind, code=requireValue('Code');
        if(incumbentKeys.has(key))throw new Error(existingCodeMessage);
        const companyValue=requireValue('Company'),matches=c.companies.filter(co=>co.id===companyValue||co.name===companyValue);
        const co=matches.length===1?matches[0]:undefined;
        if(!co)throw new Error('Company is unknown or ambiguous.');
        if(!co.writable||co.archived)throw new Error('Company is archived or outside your administrator scope.');
        v.Company=companyCell(c.companies,co.id);
        if(!['companies','global'].includes(v.Criteria))throw new Error('Criteria must be companies or global.');
        const shared=list(v['Criteria Companies']).map(value=>{const matches=c.companies.filter(co=>co.id===value||co.name===value);if(matches.length!==1)throw new Error('A Criteria company is unknown or ambiguous. Use a company from Reference.');return matches[0].id;}).sort();
        v['Criteria Companies']=shared.map(id=>companyCell(c.companies,id)).sort().join(';');
        if(v.Criteria==='global'&&!c.groupAdmin)throw new Error('Global criteria require a group administrator.');
        if((v.Criteria==='companies')!==(shared.length>0))throw new Error('Companies criteria require a nonempty company list; Global must leave Criteria Companies blank.');
        if(shared.some(id=>!c.companies.some(co=>co.id===id&&co.writable&&!co.archived)))throw new Error('A Criteria company is archived or outside your administrator scope.');
        const head=v['Head Employee Code'],heads=head?c.employees.filter(e=>e.companyId===co.id&&e.code===head&&e.active):[];
        if(head&&heads.length!==1)throw new Error('Head Employee Code must identify one active employee in the origin company.');
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])if('required' in col&&col.required)requireValue({code:'Code',label:'Label',description:'Description'}[col.headerKey]);
        // Import uniqueness is category-wide, unlike ordinary manual Criteria editing.
        if(!identify(`${kind}|${lower(code.trim())}`))continue;
        const fields:Partial<LabelCreateInput>={companyId:co.id,label:v.Label};
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])Object.assign(fields,{[col.field]:v[{code:'Code',label:'Label',description:'Description'}[col.headerKey]]});
        if('Head Employee Code' in v)fields.headEmploymentId=heads[0]?.id??null;
        add(async()=>{},{kind,create:{...fields,key,companyId:co.id,isGlobal:v.Criteria==='global',companyIds:shared} as LabelCreateInput});
      }else if((EMPLOYMENT_LABEL_CATEGORIES as readonly string[]).includes(row.sheet)){
        const value=requireValue('Code');
        if(c.options.some(option=>option.category===row.sheet&&option.value===value))throw new Error(existingCodeMessage);
        v.Label=v.Label||value;v['Sort Order']=String(whole(v['Sort Order']));
        if(!identify(`${row.sheet}|${value}`))continue;
        add(()=>createProfileOption(ctx,{category:row.sheet,value,label:v.Label,description:v.Description,sortOrder:Number(v['Sort Order'])},tx));
      }else if(row.sheet==='grades'){
        const code=requireValue('Code');
        if(!/^[A-Z][A-Z0-9_]{0,31}$/.test(code))throw new Error('Grade Code must use uppercase letters, digits or underscores.');
        if(c.grades.some(grade=>grade.code===code))throw new Error(existingCodeMessage);
        const name=requireValue('Label');v.Rank=String(whole(v.Rank));
        if(!identify(`grades|${code}`))continue;
        if(c.grades.some(grade=>!grade.archivedAt&&lower(grade.name)===lower(name))||names.has(lower(name)))throw new Error('Another grade already uses this Label.');
        names.add(lower(name));add(()=>createJobGrade(ctx,{code,name,rank:Number(v.Rank),description:v.Description},tx));
      }else{
        const name=requireValue('Name');
        if(c.groups.some(group=>lower(group.name)===lower(name)))throw new Error(existingCodeMessage);
        const codes=list(v['Grade Codes']);v['Grade Codes']=codes.join(';');
        const grades=codes.map(code=>c.grades.find(grade=>grade.code===code&&!grade.archivedAt));
        if(grades.some(grade=>!grade))throw new Error('Grade Codes must reference existing active grades. Import new grades separately first.');
        for(const grade of grades)if(c.members.some(member=>member.gradeId===grade!.id)||memberClaims.has(grade!.id))throw new Error('A grade already belongs to another group. Change its membership in the editor first.');
        if(!identify(`grade_groups|${lower(name)}`))continue;
        for(const grade of grades)memberClaims.add(grade!.id);
        add(()=>createGradeGroup(ctx,{name,gradeIds:grades.map(grade=>grade!.id)},tx));
      }
    }catch(error){if(error instanceof Error&&error.message===existingCodeMessage)result.reason='existing';result.outcome='error';result.selected=false;result.message=error instanceof Error?error.message:'Invalid label row.';}
  }
  for(const result of output)if(result.warnings?.length)result.message=[result.message,...result.warnings].join(' ');
  const orgGroups=new Map<OrganisationLabelKind,LabelCreateInput[]>(),apply:(()=>Promise<unknown>)[]=[];
  const selectedWrites=writes.filter(write=>output.some(row=>row.selected&&row.outcome==='add'&&row.sheet+':'+row.row===write.key));
  for(const write of selectedWrites){if(!write.org){apply.push(write.apply);continue;}orgGroups.set(write.org.kind,[...(orgGroups.get(write.org.kind)??[]),write.org.create]);}
  for(const kind of ORGANISATION_LABEL_KINDS){const creates=orgGroups.get(kind);if(creates?.length)apply.push(()=>bulkSaveLabels(ctx,kind,{creates,updates:[]},tx));}
  const token=createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,'add',c,audit,output])).digest('hex');
  return {preview:{token,rows:output,valid:selectedWrites.length>0,mode:'add'},writes:apply};
}

export function previewSystemLabelImport(ctx:SessionContext,bytes:Buffer,_legacyMode:LabelImportMode='add',selectedKeys?:string[]): Promise<LabelImportPreview> {
  const rows=readSystemLabelWorkbook(bytes);
  if(!rows.length)throw new Error('The workbook contains no label data. Fill in new codes in a recognised category sheet.');
  return withTenant(ctx,async tx=>{const audit=await readExportAudit(tx,ctx,systemLabelExportId(bytes));return (await analyse(tx,ctx,rows,audit,selectedKeys)).preview;});
}

export function applySystemLabelImport(ctx:SessionContext,p:{bytes:Buffer;mode?:LabelImportMode;token:string;confirmUpdates?:boolean;selectedKeys?:string[]}): Promise<{imported:number;updated:number;skipped:number;failed:number;errorReport?:string}> {
  const rows=readSystemLabelWorkbook(p.bytes);
  return withTenant(ctx,async tx=>{
    // Same lock order as the canonical owners; an unexpected writer refusal rolls back all additions.
    await tx.execute(sql`LOCK TABLE profile_option, job_grade, grade_group, grade_group_member IN SHARE ROW EXCLUSIVE MODE`);
    await lockLabelCriteriaTx(tx,ctx.tenantId);
    const audit=await readExportAudit(tx,ctx,systemLabelExportId(p.bytes));
    const {preview,writes}=await analyse(tx,ctx,rows,audit,p.selectedKeys);
    if(preview.token!==p.token)throw new Error('Labels or permissions changed since preview. Preview the workbook again.');
    if(!preview.valid)throw new Error('There are no valid new codes to import. Edit existing codes on the System Labels page.');
    for(const write of writes)await write();
    const summary={imported:preview.rows.filter(row=>row.selected&&row.outcome==='add').length,updated:0,
      skipped:preview.rows.filter(row=>!row.selected||row.outcome!=='add').length,failed:0};
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'system-label-import',aggregateId:randomUUID(),eventType:'system-label-import.applied',actor:actorOf(ctx),payload:{mode:'add',summary,rows:preview.rows.filter(row=>row.selected&&row.outcome==='add')}});
    const blocked=preview.rows.filter(row=>!row.selected||row.outcome!=='add');
    return {...summary,...(blocked.length?{errorReport:Buffer.from(systemLabelErrorWorkbook(blocked)).toString('base64')}:{})};
  });
}
