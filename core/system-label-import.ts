import { todayInKualaLumpur } from '../lib/hr-date';
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as s from '../db/schema';
import { actorOf, appendEvent } from '../db/events';
import { bulkSaveLabels, createJobGrade, updateJobGrade, type LabelCreateInput, type LabelUpdateInput } from './admin';
import { createProfileOption, updateProfileOption } from './profile-options';
import { assignLabelToCompanies, setLabelGlobal } from './system-labels';
import { createGradeGroup, updateGradeGroup } from '../packs/leave/service';
import { EMPLOYMENT_LABEL_CATEGORIES, LABEL_IMPORT_DEFINITIONS, ORGANISATION_LABEL_KINDS,
  ORGANISATION_LABEL_COLUMNS, type OrganisationLabelKind, type LabelImportMode,
  type LabelImportRow, type LabelImportPreview, type LabelImportPreviewRow } from '../lib/system-label-definition';
import { readSystemLabelWorkbook, systemLabelTemplate } from '../lib/system-label-workbook';

const lower = (v: string) => v.toLowerCase();
const list = (v: string) => [...new Set(v.split(';').map(x => x.trim()).filter(Boolean))].sort();
const whole = (v: string) => { if (v && !/^-?\d{1,9}$/.test(v)) throw new Error('Rank and Sort Order must be whole numbers.'); return Number(v || 0); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Org = { kind: OrganisationLabelKind; id: string; companyId: string; archived: boolean;
  values: Record<string, string>; original: LabelUpdateInput };

type Catalogue = {
  companies:{id:string;name:string;archived:Date|null;writable:boolean}[];
  orgs:Org[];options:(typeof s.profileOption.$inferSelect)[];grades:(typeof s.jobGrade.$inferSelect)[];
  groups:(typeof s.gradeGroup.$inferSelect)[];members:(typeof s.gradeGroupMember.$inferSelect)[];
  employees:{id:string;code:string|null;companyId:string;name:string;active:boolean}[];groupAdmin:boolean;
};
async function catalogue(tx: Tx): Promise<Catalogue> {
  const permission = await tx.execute(sql`select app.is_admin() as allowed, app.is_group_admin() as global`) as unknown as {allowed:boolean;global:boolean}[];
  if (!permission[0]?.allowed) throw new Error('Only an administrator may import System Labels.');
  const [companies, departments, positions, costs, units, options, grades, groups, members, assignments, employees] = await Promise.all([
    tx.select({ id:s.company.id,name:s.company.legalName, archived:s.company.archivedAt,
      writable:sql<boolean>`app.is_admin_for(${s.company.id})` }).from(s.company).orderBy(asc(s.company.id)),
    tx.select().from(s.department).orderBy(asc(s.department.id)), tx.select().from(s.position).orderBy(asc(s.position.id)),
    tx.select().from(s.costCenter).orderBy(asc(s.costCenter.id)), tx.select().from(s.businessUnit).orderBy(asc(s.businessUnit.id)),
    tx.select().from(s.profileOption).orderBy(asc(s.profileOption.id)), tx.select().from(s.jobGrade).orderBy(asc(s.jobGrade.id)),
    tx.select().from(s.gradeGroup).orderBy(asc(s.gradeGroup.id)), tx.select().from(s.gradeGroupMember).orderBy(asc(s.gradeGroupMember.id)),
    tx.select().from(s.labelCompanyAssignment).orderBy(asc(s.labelCompanyAssignment.id)),
    tx.select({id:s.employment.id,code:s.employment.employeeCode,companyId:s.employment.companyId,name:s.person.fullName,active:sql<boolean>`(${s.employment.terminatedOn} is null or ${s.employment.terminatedOn} >= ${todayInKualaLumpur()}::date) and ${s.employment.hiredOn} <= ${todayInKualaLumpur()}::date`})
      .from(s.employment).innerJoin(s.person,eq(s.person.id,s.employment.personId)).orderBy(asc(s.employment.id)),
  ]);
  const orgs: Org[] = [];
  const normalise = (kind: OrganisationLabelKind, rows: (typeof departments[number] | typeof positions[number] | typeof costs[number] | typeof units[number])[]) => {
    for (const r of rows) {
      const field = (key: string) => String((r as unknown as Record<string,unknown>)[key] ?? '');
      const shared = assignments.filter(a => a.labelId === r.id && a.labelKind === kind && a.companyId !== r.companyId).map(a => a.companyId).sort();
      const values: Record<string,string> = { Company:companies.find(co=>co.id===r.companyId)?.name??r.companyId, Scope:r.isGlobal?'global':shared.length?'shared':'own', 'Shared Companies':r.isGlobal?'':shared.map(id=>companies.find(co=>co.id===id)?.name??id).sort().join(';') };
      for (const c of ORGANISATION_LABEL_COLUMNS[kind]) values[{code:'Code',label:'Label',description:'Description'}[c.headerKey]] = field(c.field);
      if (kind === 'department' || kind === 'business_unit') values['Head Employee Code'] = employees.find(e => e.id === field('headEmploymentId'))?.code ?? '';
      orgs.push({kind,id:r.id,companyId:r.companyId,archived:r.archivedAt!=null,values,
        original:{key:r.id,id:r.id,name:field('name'),title:field('title'),code:field('code'),label:field('label'),
          description:field('description'),jobFamily:field('jobFamily')} });
    }
  };
  normalise('department',departments);normalise('position',positions);normalise('cost_center',costs);normalise('business_unit',units);
  return {companies,orgs,options,grades,groups,members,employees,groupAdmin:permission[0].global};
}

export function downloadSystemLabelTemplate(ctx: SessionContext): Promise<Buffer> {
  return withTenant(ctx,async tx => {
    const c=await catalogue(tx);
    return systemLabelTemplate({companies:c.companies.filter(x=>x.writable&&!x.archived).map(x=>[x.name,x.id]),
      grades:c.grades.filter(x=>!x.archivedAt).map(x=>[x.code,x.name]),
      employees:c.employees.filter(x=>c.companies.some(co=>co.id===x.companyId&&co.writable)&&x.code).map(x=>[x.code!,x.companyId,x.name])});
  });
}

async function analyse(tx: Tx, ctx: SessionContext, rows: LabelImportRow[], mode: LabelImportMode): Promise<{preview:LabelImportPreview;writes:(()=>Promise<unknown>)[]}> {
  if (mode!=='add'&&mode!=='update') throw new Error('Choose Add New or Update Existing.');
  const c=await catalogue(tx), output:LabelImportPreviewRow[]=[], writes:(()=>Promise<unknown>)[]=[];
  const seen=new Map<string,Record<string,string>>(), names=new Set<string>(), memberClaims=new Map<string,string>();
  for (const row of rows) {
    const result:LabelImportPreviewRow={...row,outcome:'error',message:'',before:null,after:{...row.values}};
    output.push(result);
    try {
      const definition=LABEL_IMPORT_DEFINITIONS.find(d=>d.kind===row.sheet);
      if(!definition)throw new Error('Unsupported label category.');
      const v=result.after;
      const requireValue=(key:string)=>{if(!v[key])throw new Error(`${key} is required.`);return v[key];};
      const identify=(key:string)=>{
        const previous=seen.get(key);
        if(previous){if(!same(previous,v))throw new Error('Conflicting rows in this workbook use the same identifier.');result.outcome='skip';result.message='Exact duplicate row in this workbook.';return false;}
        seen.set(key,v);return true;
      };
      const classify=(before:Record<string,string>|null, apply:()=>Promise<unknown>)=>{
        result.before=before;
        if(before&&same(before,v)){result.outcome='skip';result.message='Exact duplicate; no change.';return;}
        if(before&&mode==='add')throw new Error('Existing identifier has different values. Use Update Existing or correct the row.');
        result.outcome=before?'update':'add';result.message=before?'Review the current and proposed values.':'Valid new option.';writes.push(apply);
      };
      if ((ORGANISATION_LABEL_KINDS as readonly string[]).includes(row.sheet)) {
        const kind=row.sheet as OrganisationLabelKind, companyValue=requireValue('Company'), code=requireValue('Code');
        const matches=c.companies.filter(x=>x.id===companyValue||x.name===companyValue);
        const co=matches.length===1?matches[0]:undefined;
        if(!co?.writable||co.archived)throw new Error('Company is unknown, archived or outside your administrator scope.');
        const companyId=co.id;v.Company=co.name;
        if(!['own','shared','global'].includes(v.Scope))throw new Error('Scope must be own, shared or global.');
        const shared=list(v['Shared Companies']).map(value=>{const matches=c.companies.filter(x=>x.id===value||x.name===value);if(matches.length!==1)throw new Error('A shared company is unknown or ambiguous. Use a company from Reference.');return matches[0].id;}).sort();v['Shared Companies']=shared.map(id=>c.companies.find(x=>x.id===id)!.name).sort().join(';');
        if(v.Scope==='global'&&!c.groupAdmin)throw new Error('Global options require a group administrator.');
        if((v.Scope==='shared')!==(shared.length>0)||shared.includes(companyId))throw new Error('Shared scope needs additional company IDs; own/global scope must leave Shared Companies blank.');
        if(shared.some(id=>!c.companies.some(x=>x.id===id&&x.writable&&!x.archived)))throw new Error('A shared company is unknown, archived or outside your administrator scope.');
        const head=v['Head Employee Code'];
        const headMatches=head?c.employees.filter(e=>e.companyId===companyId&&e.code===head&&e.active):[];
        if(head&&headMatches.length!==1)throw new Error('Head Employee Code must identify one active employee in the origin company.');
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])if('required' in col&&col.required)requireValue({code:'Code',label:'Label',description:'Description'}[col.headerKey]);
        const twins=c.orgs.filter(x=>x.kind===kind&&x.companyId===companyId&&lower(x.values.Code)===lower(code));
        const old=twins.find(x=>!x.archived)??twins[0];
        if(old?.archived)throw new Error('Restore the archived option in System Labels first.');
        if(old&&old.values.Code!==code)throw new Error('Keep the existing Code spelling; import cannot rename an identifier.');
        if(old&&(old.values.Scope!==v.Scope||old.values['Shared Companies']!==v['Shared Companies']))throw new Error('Existing company scope cannot change through import. Use the scope editor.');
        if(!identify(`${kind}|${companyId}|${lower(code)}`))continue;
        const fields:Partial<LabelCreateInput>={companyId,label:v.Label};
        for(const col of ORGANISATION_LABEL_COLUMNS[kind])Object.assign(fields,{[col.field]:v[{code:'Code',label:'Label',description:'Description'}[col.headerKey]]});
        if('Head Employee Code' in v)fields.headEmploymentId=headMatches[0]?.id??null;
        classify(old?.values??null,async()=>{
          if(old)return bulkSaveLabels(ctx,kind,{creates:[],updates:[{...old.original,...fields,key:old.id,id:old.id}]},tx);
          const created=await bulkSaveLabels(ctx,kind,{creates:[{...fields,key:`${row.sheet}:${row.row}`,companyId} as LabelCreateInput],updates:[]},tx);
          const id=created.createdIds[0].id;
          if(v.Scope==='global')await setLabelGlobal(ctx,{kind,labelId:id,isGlobal:true},tx);
          if(shared.length)await assignLabelToCompanies(ctx,{kind,labelId:id,companyIds:shared},tx);
          return created;
        });
      } else if ((EMPLOYMENT_LABEL_CATEGORIES as readonly string[]).includes(row.sheet)) {
        const value=requireValue('Code');v.Label=v.Label||value;v['Sort Order']=String(whole(v['Sort Order']));
        const old=c.options.find(x=>x.category===row.sheet&&x.value===value);
        if(old&&!old.isActive)throw new Error('Activate the existing option in System Labels first.');
        if(!identify(`${row.sheet}|${value}`))continue;
        const before=old?{Code:old.value,Label:old.label,Description:old.description??'','Sort Order':String(old.sortOrder)}:null;
        classify(before,()=>old?updateProfileOption(ctx,{id:old.id,label:v.Label,description:v.Description,sortOrder:Number(v['Sort Order'])},tx)
          :createProfileOption(ctx,{category:row.sheet,value,label:v.Label,description:v.Description,sortOrder:Number(v['Sort Order'])},tx));
      } else if(row.sheet==='grades') {
        const code=requireValue('Code'),name=requireValue('Label');v.Rank=String(whole(v.Rank));
        if(!/^[A-Z][A-Z0-9_]{0,31}$/.test(code))throw new Error('Grade Code must use uppercase letters, digits or underscores.');
        const old=c.grades.find(x=>x.code===code&&!x.archivedAt)??c.grades.find(x=>x.code===code);
        if(old?.archivedAt)throw new Error('Restore the archived grade first.');
        if(!identify(`grades|${code}`))continue;
        if(c.grades.some(x=>!x.archivedAt&&lower(x.name)===lower(name)&&x.id!==old?.id)||names.has(lower(name)))throw new Error('Another grade already uses this Label.');
        names.add(lower(name));
        classify(old?{Code:old.code,Label:old.name,Description:old.description??'',Rank:String(old.rank)}:null,
          ()=>old?updateJobGrade(ctx,{id:old.id,name,rank:Number(v.Rank),description:v.Description},tx):createJobGrade(ctx,{code,name,rank:Number(v.Rank),description:v.Description},tx));
      } else {
        const name=requireValue('Name'),codes=list(v['Grade Codes']);v['Grade Codes']=codes.join(';');
        const old=c.groups.find(x=>lower(x.name)===lower(name)&&!x.archivedAt)??c.groups.find(x=>lower(x.name)===lower(name));
        if(old?.archivedAt)throw new Error('Restore the archived grade group first.');
        if(old&&old.name!==name)throw new Error('Keep the existing group Name spelling.');
        const grades=codes.map(code=>c.grades.find(g=>g.code===code&&!g.archivedAt));
        if(grades.some(g=>!g))throw new Error('Grade Codes must reference existing active grades. Import new grades separately first.');
        for(const grade of grades){
          if(c.members.some(m=>m.gradeId===grade!.id&&m.gradeGroupId!==old?.id)||memberClaims.has(grade!.id)&&memberClaims.get(grade!.id)!==name)
            throw new Error('A grade already belongs to another group. Change its membership in the editor first.');
        }
        if(!identify(`grade_groups|${lower(name)}`))continue;
        for(const grade of grades)memberClaims.set(grade!.id,name);
        const before=old?{Name:old.name,'Grade Codes':c.members.filter(m=>m.gradeGroupId===old.id).map(m=>c.grades.find(g=>g.id===m.gradeId)?.code??'').sort().join(';')}:null;
        classify(before,()=>old?updateGradeGroup(ctx,{id:old.id,name,gradeIds:grades.map(g=>g!.id)},tx):createGradeGroup(ctx,{name,gradeIds:grades.map(g=>g!.id)},tx));
      }
    } catch(error) {
      result.outcome='error';result.message=error instanceof Error?error.message:'Invalid label row.';
    }
  }
  const token=createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,mode,c,output])).digest('hex');
  return {preview:{token,rows:output,valid:output.length>0&&!output.some(x=>x.outcome==='error')} satisfies LabelImportPreview,writes};
}

export function previewSystemLabelImport(ctx:SessionContext,bytes:Buffer,mode:LabelImportMode): Promise<LabelImportPreview> {
  const rows=readSystemLabelWorkbook(bytes);
  return withTenant(ctx,async tx=>(await analyse(tx,ctx,rows,mode)).preview);
}

export function applySystemLabelImport(ctx:SessionContext,p:{bytes:Buffer;mode:LabelImportMode;token:string;confirmUpdates:boolean}): Promise<{imported:number;updated:number;skipped:number;failed:number}> {
  const rows=readSystemLabelWorkbook(p.bytes);
  return withTenant(ctx,async tx=>{
    // Existing editors use these same tables. Hold their writers until revalidation and the batch commit.
    await tx.execute(sql`LOCK TABLE department, "position", cost_center, business_unit, profile_option, job_grade,
      grade_group, grade_group_member, label_company_assignment, company, employment IN SHARE ROW EXCLUSIVE MODE`);
    const {preview,writes}=await analyse(tx,ctx,rows,p.mode);
    if(!preview.valid)throw new Error('Correct every invalid or conflicting row before importing.');
    if(preview.token!==p.token)throw new Error('Labels or permissions changed since preview. Preview the workbook again.');
    if(preview.rows.some(r=>r.outcome==='update')&&!p.confirmUpdates)throw new Error('Confirm the current and proposed values before updating existing options.');
    for(const write of writes)await write();
    const summary={imported:preview.rows.filter(r=>r.outcome==='add').length,updated:preview.rows.filter(r=>r.outcome==='update').length,
      skipped:preview.rows.filter(r=>r.outcome==='skip').length,failed:0};
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'system-label-import',aggregateId:randomUUID(),eventType:'system-label-import.applied',actor:actorOf(ctx),payload:{mode:p.mode,summary,rows:preview.rows}});
    return summary;
  });
}
