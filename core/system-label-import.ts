import { todayInKualaLumpur } from '../lib/hr-date';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, sql, isNull, inArray, getTableName } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as s from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { bulkSaveLabels, createJobGrade, type LabelCreateInput, type LabelUpdateInput } from './admin';
import { createProfileOption } from './profile-options';
import { employmentStatusSql } from './employment-status-sql';
import { visibleLabelIdsCondition, labelMaintenanceCondition, SYSTEM_LABEL_MAINTENANCE_LIMIT, boundedLabelMaintenanceRows, lockLabelCriteriaTx, existingSystemLabelImportKeysTx } from './system-labels';
import { createGradeGroup } from '../packs/leave/service';
import { EMPLOYMENT_LABEL_CATEGORIES, LABEL_IMPORT_DEFINITIONS, ORGANISATION_LABEL_KINDS,
  ORGANISATION_LABEL_COLUMNS, type OrganisationLabelKind, type LabelImportMode,
  type LabelImportRow, type LabelImportPreview, type LabelImportPreviewRow, type LabelImportRowReason, type LabelImportRequiredField } from '../lib/system-label-definition';
import { readSystemLabelWorkbook, buildSystemLabelWorkbook, buildSystemLabelUploadTemplate, systemLabelExportId, systemLabelErrorWorkbook } from '../lib/system-label-workbook';

class LabelImportRowError extends Error {
  constructor(readonly reason:LabelImportRowReason,message:string,readonly reasonField?:LabelImportRequiredField){super(message);}
}
const lower = (v: string) => v.toLowerCase();
const list = (v: string) => [...new Set(v.split(';').map(x => x.trim()).filter(Boolean))].sort();
const whole = (v: string) => { if (v && !/^-?\d{1,9}$/.test(v)) throw new LabelImportRowError('wholeNumber','Rank and Sort Order must be whole numbers.'); return Number(v || 0); };
const same = (a: Record<string,string>, b: Record<string,string>) => JSON.stringify(Object.keys(a).sort().map(key=>[key,a[key]])) === JSON.stringify(Object.keys(b).sort().map(key=>[key,b[key]]));
type Org = { kind: OrganisationLabelKind; id: string; companyId: string; archived: boolean;
  values: Record<string, string>; original: LabelUpdateInput };

type Catalogue = {
  companies:{id:string;name:string;archived:Date|null;writable:boolean}[];
  orgs:Org[];options:(typeof s.profileOption.$inferSelect)[];grades:(typeof s.jobGrade.$inferSelect)[];
  groups:(typeof s.gradeGroup.$inferSelect)[];members:(typeof s.gradeGroupMember.$inferSelect)[];
  employees:{id:string;code:string|null;companyId:string;name:string;active:boolean}[];groupAdmin:boolean;
};
const companyCell=(companies:Catalogue['companies'],id:string)=>{const co=companies.find(x=>x.id===id);return co&&!co.name.includes(';')&&companies.filter(x=>x.name===co.name).length===1?co.name:id;};
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
    tx.select({id:s.employment.id,code:s.employment.employeeCode,companyId:s.employment.companyId,name:s.person.fullName,active:sql<boolean>`(${employmentStatusSql()}) in ('active','active_serving_notice','probation') and ${s.employment.hiredOn} <= ${todayInKualaLumpur()}::date`})
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

/** Sample is a minimal derived projection, filtered before each category's stable three-row limit.
 * Origin administration and Criteria visibility are independent gates. */
export function downloadSystemLabelTemplate(ctx: SessionContext, selectedCompanyIds?:string[]): Promise<Buffer> {
  return withTenant(ctx,async tx => {
    const permission=await tx.execute(sql`select app.is_admin() as allowed`) as unknown as {allowed:boolean}[];
    if(!permission[0]?.allowed)throw new Error('Only an administrator may import System Labels.');
    // Names are exposed only after their own administration check; ambiguous names use exact IDs.
    const companyName=(id:ReturnType<typeof sql>)=>sql<string>`(select case when (select count(*) from company same_name where same_name.tenant_id=co.tenant_id and same_name.legal_name=co.legal_name and app.is_admin_for(same_name.id))=1 and position(';' in co.legal_name)=0 then co.legal_name else co.id::text end from company co where co.id=${id} and app.is_admin_for(co.id) and co.archived_at is null)`;
    const companies=await tx.select({id:s.company.id,name:s.company.legalName,cell:companyName(sql`company.id`)}).from(s.company).where(and(
      sql`app.is_admin_for(${s.company.id})`,isNull(s.company.archivedAt),
      selectedCompanyIds===undefined?sql`true`:selectedCompanyIds.length?inArray(s.company.id,[...new Set(selectedCompanyIds)]):sql`false`,
    )).orderBy(asc(s.company.legalName),asc(s.company.id)).limit(SYSTEM_LABEL_MAINTENANCE_LIMIT+1);
    boundedLabelMaintenanceRows(companies);
    const selected=companies.map(company=>company.id),samples:Record<string,Record<string,string>[]>={};
    for(const kind of ORGANISATION_LABEL_KINDS){
      const table={department:s.department,position:s.position,cost_center:s.costCenter,business_unit:s.businessUnit}[kind];
      const outer=sql.identifier(getTableName(table));
      const code={department:s.department.name,position:s.position.title,cost_center:s.costCenter.code,business_unit:s.businessUnit.code}[kind];
      const description={department:s.department.description,position:s.position.description,cost_center:s.costCenter.name,business_unit:s.businessUnit.name}[kind];
      const headColumn=kind==='department'?s.department.headEmploymentId:kind==='business_unit'?s.businessUnit.headEmploymentId:null;
      const head=headColumn?sql<string>`(select employment.employee_code || ' — ' || p.full_name from employment join person p on p.id=employment.person_id and p.tenant_id=employment.tenant_id where employment.id=${headColumn} and employment.company_id=${outer}.company_id and app.is_admin_for(employment.company_id) and employment.employee_code is not null and employment.hired_on<=${todayInKualaLumpur()}::date and (${employmentStatusSql()}) in ('active','active_serving_notice','probation') limit 1)`:sql<string>`''`;
      const rows=await tx.select({code,label:table.label,description,company:companyName(sql`${outer}.company_id`),global:table.isGlobal,
        criteria:sql<string[]>`array(select ${companyName(sql`lca.company_id`)} from label_company_assignment lca where lca.tenant_id=${outer}.tenant_id and lca.label_kind=${kind} and lca.label_id=${outer}.id order by lca.company_id)`,head,
      }).from(table).where(and(isNull(table.archivedAt),sql`app.is_admin_for(${table.companyId})`,sql`${companyName(sql`${outer}.company_id`)} is not null`,visibleLabelIdsCondition(table,kind,selected),
        sql`not exists(select 1 from label_company_assignment private_criteria join company private_company on private_company.id=private_criteria.company_id and private_company.tenant_id=private_criteria.tenant_id where private_criteria.tenant_id=${table.tenantId} and private_criteria.label_kind=${kind} and private_criteria.label_id=${table.id} and (not app.is_admin_for(private_company.id) or private_company.archived_at is not null))`,
      )).orderBy(asc(code),asc(table.id)).limit(3);
      samples[kind]=rows.map(row=>({Code:row.code,Label:row.label??'',Description:row.description??'',Company:row.company,Criteria:row.global?'global':'companies','Criteria Companies':row.global?'':row.criteria.join(';'),'Head Employee Code':row.head??'',Status:'Active'}));
    }
    for(const category of EMPLOYMENT_LABEL_CATEGORIES){
      const rows=await tx.select({code:s.profileOption.value,label:s.profileOption.label,description:s.profileOption.description}).from(s.profileOption).where(and(eq(s.profileOption.category,category),eq(s.profileOption.isActive,true))).orderBy(asc(s.profileOption.value),asc(s.profileOption.id)).limit(3);
      samples[category]=rows.map(row=>({Code:row.code,Label:row.label,Description:row.description??'',Status:'Active'}));
    }
    const grades=await tx.select({code:s.jobGrade.code,label:s.jobGrade.name,description:s.jobGrade.description,rank:s.jobGrade.rank}).from(s.jobGrade).where(isNull(s.jobGrade.archivedAt)).orderBy(asc(s.jobGrade.code),asc(s.jobGrade.id)).limit(3);
    samples.grades=grades.map(row=>({Code:row.code,Label:row.label,Description:row.description??'',Rank:String(row.rank),Status:'Active'}));
    const groups=await tx.select({name:s.gradeGroup.name,codes:sql<string[]>`array(select jg.code from grade_group_member member join job_grade jg on jg.id=member.grade_id and jg.tenant_id=member.tenant_id where member.grade_group_id=grade_group.id and member.tenant_id=grade_group.tenant_id order by jg.code,jg.id)`}).from(s.gradeGroup).where(isNull(s.gradeGroup.archivedAt)).orderBy(asc(s.gradeGroup.name),asc(s.gradeGroup.id)).limit(3);
    samples.grade_groups=groups.map(row=>({Name:row.name,'Grade Codes':row.codes.join(';')}));
    const heads=[...new Set(ORGANISATION_LABEL_KINDS.flatMap(kind=>samples[kind].map(row=>row['Head Employee Code']).filter(Boolean)))];
    return buildSystemLabelUploadTemplate({samples,suggestions:{Company:companies.map(company=>company.cell),'Head Employee Code':heads,'Grade Codes':grades.map(grade=>grade.code)}});
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
      if(!definition)throw new LabelImportRowError('unsupportedCategory','Unsupported label category. This worksheet was not imported.');
      const v=result.after;
      // Legacy exports spelled inactive differently; preserve its state rather than discarding it.
      const status=v.Status==='Archived / Inactive'?'Inactive':v.Status||'Active';
      if(!['Active','Inactive'].includes(status)||(row.sheet==='grade_groups'&&status!=='Active'))throw new LabelImportRowError('invalidStatus','Status must be Active or Inactive. Grade Groups does not support an initial inactive status.');
      const active=status==='Active';
      if(row.sheet!=='grade_groups')v.Status=status;
      const requireValue=(field:LabelImportRequiredField)=>{if(!v[field])throw new LabelImportRowError('required',`${field} is required.`,field);return v[field];};
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
        if(incumbentKeys.has(key))throw new LabelImportRowError('existing',existingCodeMessage);
        const companyValue=requireValue('Company'),matches=c.companies.filter(co=>co.id===companyValue||co.name===companyValue);
        const co=matches.length===1?matches[0]:undefined;
        if(!co)throw new LabelImportRowError('invalidCompany','Company is unknown or ambiguous.');
        if(!co.writable||co.archived)throw new LabelImportRowError('invalidCompany','Company is archived or outside your administrator scope.');
        v.Company=companyCell(c.companies,co.id);
        if(!['companies','global'].includes(v.Criteria))throw new LabelImportRowError('invalidCriteria','Criteria must be companies or global.');
        const shared=list(v['Criteria Companies']).map(value=>{const matches=c.companies.filter(co=>co.id===value||co.name===value);if(matches.length!==1)throw new LabelImportRowError('invalidCriteriaCompany','A Criteria company is unknown or ambiguous. Use a company from Reference.');return matches[0].id;}).sort();
        v['Criteria Companies']=shared.map(id=>companyCell(c.companies,id)).sort().join(';');
        if(v.Criteria==='global'&&!c.groupAdmin)throw new LabelImportRowError('globalAdminRequired','Global criteria require a group administrator.');
        if((v.Criteria==='companies')!==(shared.length>0))throw new LabelImportRowError('criteriaCompaniesRequired','Companies criteria require a nonempty company list; Global must leave Criteria Companies blank.');
        if(shared.some(id=>!c.companies.some(co=>co.id===id&&co.writable&&!co.archived)))throw new LabelImportRowError('invalidCriteriaCompany','A Criteria company is archived or outside your administrator scope.');
        const head=v['Head Employee Code'],heads=head?c.employees.filter(e=>e.companyId===co.id&&(e.code===head||`${e.code} — ${e.name}`===head)&&e.active):[];
        if(heads.length===1)v['Head Employee Code']=heads[0].code!;
        if(head&&heads.length!==1)throw new LabelImportRowError('invalidHeadEmployee','Head Employee Code must identify one active employee in the origin company.');
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])if('required' in col&&col.required)requireValue(({code:'Code',label:'Label',description:'Description'} as const)[col.headerKey]);
        // Import uniqueness is category-wide, unlike ordinary manual Criteria editing.
        if(!identify(`${kind}|${lower(code.trim())}`))continue;
        const fields:Partial<LabelCreateInput>={companyId:co.id,label:v.Label,archived:!active};
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])Object.assign(fields,{[col.field]:v[{code:'Code',label:'Label',description:'Description'}[col.headerKey]]});
        if('Head Employee Code' in v)fields.headEmploymentId=heads[0]?.id??null;
        add(async()=>{},{kind,create:{...fields,key,companyId:co.id,isGlobal:v.Criteria==='global',companyIds:shared} as LabelCreateInput});
      }else if((EMPLOYMENT_LABEL_CATEGORIES as readonly string[]).includes(row.sheet)){
        const value=requireValue('Code');
        if(c.options.some(option=>option.category===row.sheet&&option.value===value))throw new LabelImportRowError('existing',existingCodeMessage);
        v.Label=v.Label||value;v['Sort Order']=String(whole(v['Sort Order']));
        if(!identify(`${row.sheet}|${value}`))continue;
        add(()=>createProfileOption(ctx,{category:row.sheet,value,label:v.Label,description:v.Description,sortOrder:Number(v['Sort Order']),isActive:active},tx));
      }else if(row.sheet==='grades'){
        const code=requireValue('Code');
        if(!/^[A-Z][A-Z0-9_]{0,31}$/.test(code))throw new LabelImportRowError('invalidGradeCode','Grade Code must use uppercase letters, digits or underscores.');
        if(c.grades.some(grade=>grade.code===code))throw new LabelImportRowError('existing',existingCodeMessage);
        const name=requireValue('Label');v.Rank=String(whole(v.Rank));
        if(seen.has(`grades|${code}`)){identify(`grades|${code}`);continue;}
        if(c.grades.some(grade=>!grade.archivedAt&&lower(grade.name)===lower(name))||names.has(lower(name)))throw new LabelImportRowError('gradeLabelExists','Another grade already uses this Label.');
        identify(`grades|${code}`);names.add(lower(name));add(()=>createJobGrade(ctx,{code,name,rank:Number(v.Rank),description:v.Description,active},tx));
      }else{
        const name=requireValue('Name');
        if(c.groups.some(group=>lower(group.name)===lower(name)))throw new LabelImportRowError('existing',existingCodeMessage);
        const codes=list(v['Grade Codes']);v['Grade Codes']=codes.join(';');
        const grades=codes.map(code=>c.grades.find(grade=>grade.code===code&&!grade.archivedAt));
        if(grades.some(grade=>!grade))throw new LabelImportRowError('invalidGradeReferences','Grade Codes must reference existing active grades. Import new grades separately first.');
        if(seen.has(`grade_groups|${lower(name)}`)){identify(`grade_groups|${lower(name)}`);continue;}
        for(const grade of grades)if(c.members.some(member=>member.gradeId===grade!.id)||memberClaims.has(grade!.id))throw new LabelImportRowError('gradeAlreadyGrouped','A grade already belongs to another group. Change its membership in the editor first.');
        if(!identify(`grade_groups|${lower(name)}`))continue;
        for(const grade of grades)memberClaims.add(grade!.id);
        add(()=>createGradeGroup(ctx,{name,gradeIds:grades.map(grade=>grade!.id)},tx));
      }
    }catch(error){result.reason=error instanceof LabelImportRowError?error.reason:'invalidRow';if(error instanceof LabelImportRowError&&error.reasonField)result.reasonField=error.reasonField;result.outcome='error';result.selected=false;result.message=error instanceof Error?error.message:'Invalid label row.';}
  }
  // Valid subset selection is intentional, not a validation error. Keep it visible in reports.
  for(const result of output)if(result.outcome==='add'&&!result.selected){
    result.outcome='skip';result.reason='notSelected';result.message='Valid new code was not selected for this import. No record was created.';
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
