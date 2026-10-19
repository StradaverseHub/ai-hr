import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import * as s from '../db/schema';
import { applySystemLabelImport,downloadSystemLabelTemplate,previewSystemLabelImport } from '../core/system-label-import';
import { bulkSaveLabels,createCompany } from '../core/admin';
import { createProfileOption,listProfileOptions } from '../core/profile-options';
import { LABEL_TEMPLATE_DEFINITIONS,LABEL_TEMPLATE_NOTE,ORGANISATION_LABEL_KINDS,EMPLOYMENT_LABEL_CATEGORIES } from '../lib/system-label-definition';
import { buildSystemLabelWorkbook } from '../lib/system-label-workbook';
import { todayInKualaLumpur } from '../lib/hr-date';
import { deriveEmploymentStatus,type EmploymentStatusInput } from '../core/employment-status';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
function book(data:Record<string,Record<string,string>[]>) {
  const wb=XLSX.utils.book_new();
  for(const definition of LABEL_TEMPLATE_DEFINITIONS){
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([[LABEL_TEMPLATE_NOTE],definition.columns.map(([header])=>header),...(data[definition.kind]??[]).map(row=>definition.columns.map(([,key])=>row[key]??''))]),definition.sheet);
  }
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer;
}
const dataRow=(kind:string,code:string,status:string)=>({Company:b.companyId,Criteria:'companies','Criteria Companies':b.companyId,Code:code,Label:`Fictional ${code}`,Description:'Fictional description',Rank:'0',Status:status});
describe('Labels template scope and initial state through canonical writers',()=>{
  it('round-trips the actual protected-Sample download while importing only an entered upload row',async()=>{
    const zip=await JSZip.loadAsync(await downloadSystemLabelTemplate(adminCtx(b),[b.companyId]));
    const entry=zip.file('xl/worksheets/sheet8.xml')!,xml=await entry.async('string');
    expect(xml).toMatch(/<row r="3"[\s>]/);
    zip.file(entry.name,xml.replace(/<row r="3"[^>]*>[\s\S]*?<\/row>/,'<row r="3"><c r="A3" t="str"><v>PROTECTED_GUIDE_NEW</v></c><c r="B3" t="str"><v>Fictional new division</v></c><c r="D3" t="str"><v>Inactive</v></c></row>'));
    const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),preview=await previewSystemLabelImport(adminCtx(b),bytes);
    expect(preview.rows).toHaveLength(1);expect(preview.rows[0]).toMatchObject({sheet:'division',row:3,after:{Code:'PROTECTED_GUIDE_NEW',Status:'Inactive'}});
    expect(await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token})).toMatchObject({imported:1,skipped:0});
    expect((await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'PROTECTED_GUIDE_NEW')))[0].isActive).toBe(false);
  });
  it('preserves Active, Inactive and blank and refuses invalid state for all thirteen status categories',async()=>{
    const categories=LABEL_TEMPLATE_DEFINITIONS.filter(definition=>definition.kind!=='grade_groups').map(definition=>definition.kind);
    const data=Object.fromEntries(categories.map((kind,index)=>[kind,['Active','Inactive','','Not a status'].map((status,row)=>dataRow(kind,`B22_${index}_${row}`,status))]));
    const bytes=book(data),preview=await previewSystemLabelImport(adminCtx(b),bytes);
    expect(preview.rows.filter(row=>row.outcome==='add')).toHaveLength(39);
    expect(preview.rows.filter(row=>row.reason==='invalidStatus')).toHaveLength(13);
    expect(preview.rows.filter(row=>row.reason==='invalidStatus').every(row=>row.row===6)).toBe(true);
    expect(await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token})).toMatchObject({imported:39,skipped:13,updated:0});
    for(const kind of ORGANISATION_LABEL_KINDS){
      const table={department:s.department,position:s.position,cost_center:s.costCenter,business_unit:s.businessUnit}[kind];
      const index=categories.indexOf(kind),code={department:s.department.name,position:s.position.title,cost_center:s.costCenter.code,business_unit:s.businessUnit.code}[kind];
      for(const [suffix,inactive]of [[0,false],[1,true],[2,false]] as const){
        const [row]=await owner.db.select({archivedAt:table.archivedAt}).from(table).where(eq(code,`B22_${index}_${suffix}`));
        expect(row.archivedAt!==null).toBe(inactive);
      }
    }
    const gradeIndex=categories.indexOf('grades');
    for(const [suffix,inactive]of [[0,false],[1,true],[2,false]] as const){
      const [grade]=await owner.db.select().from(s.jobGrade).where(eq(s.jobGrade.code,`B22_${gradeIndex}_${suffix}`));expect(grade.archivedAt!==null).toBe(inactive);
    }
    for(const category of EMPLOYMENT_LABEL_CATEGORIES){
      const index=categories.indexOf(category),picker=await listProfileOptions(adminCtx(b),category,{activeOnly:true});
      expect(picker.some(row=>row.value===`B22_${index}_0`)).toBe(true);
      expect(picker.some(row=>row.value===`B22_${index}_1`)).toBe(false);
      expect(picker.some(row=>row.value===`B22_${index}_2`)).toBe(true);
    }
    const events=await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.eventType} in ('department.created','position.created','cost-center.created','business-unit.created','job-grade.created','profile-option.created')`);
    expect(events.filter(event=>JSON.stringify(event.payload).includes('B22_'))).toHaveLength(39);
    expect(events.some(event=>(event.payload as {archived?:boolean}).archived===true)).toBe(true);
    expect(events.some(event=>(event.payload as {active?:boolean}).active===false)).toBe(true);
    expect(events.some(event=>(event.payload as {isActive?:boolean}).isActive===false)).toBe(true);
  });
  it('deliberately maps the released Archived / Inactive spelling for new legacy rows',async()=>{
    const bytes=await buildSystemLabelWorkbook({kinds:['division'],includeStatus:true,references:{companies:[],grades:[],employees:[]},rows:{division:[{Code:'LEGACY_INACTIVE',Label:'Legacy addition',Status:'Archived / Inactive'}]}});
    const preview=await previewSystemLabelImport(adminCtx(b),bytes);expect(preview.rows[0].after.Status).toBe('Inactive');
    await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token});
    expect((await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'LEGACY_INACTIVE')))[0].isActive).toBe(false);
  });
  it('filters before the stable three-example limit and keeps tenant-wide lists with no selected companies',async()=>{
    await bulkSaveLabels(adminCtx(b),'department',{creates:['000_A','000_B','000_C','000_D'].map(code=>({key:code,companyId:b.companyId,name:code,companyIds:[b.companyId]})),updates:[]});
    await bulkSaveLabels(adminCtx(b),'department',{creates:[{key:'inactive',companyId:b.companyId,name:'000_0_INACTIVE',companyIds:[b.companyId],archived:true}],updates:[]});
    await createProfileOption(adminCtx(b),{category:'division',value:'TENANT_SHARED_EXAMPLE',label:'Shared division'});
    const bytes=await downloadSystemLabelTemplate(adminCtx(b),[b.companyId]),wb=XLSX.read(bytes,{type:'buffer'}),sample=JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Sample,{header:1,raw:false}));
    for(const value of ['000_A','000_B','000_C'])expect(sample).toContain(value);
    expect(sample).not.toContain('000_D');expect(sample).not.toContain('000_0_INACTIVE');
    const empty=XLSX.read(await downloadSystemLabelTemplate(adminCtx(b),[]),{type:'buffer'}),emptySample=JSON.stringify(XLSX.utils.sheet_to_json(empty.Sheets.Sample,{header:1,raw:false}));
    expect(emptySample).not.toContain('000_A');expect(emptySample).toContain('TENANT_SHARED_EXAMPLE');
    expect(emptySample).toContain('(example)');
    await expect(previewSystemLabelImport(adminCtx(b),bytes)).rejects.toThrow('no label data');
  });
  it('never puts hidden-origin or hidden Criteria companies into any XML part',async()=>{
    const hidden=await createCompany(adminCtx(b),{legalName:'SECRET_B22_ORIGIN'});
    await bulkSaveLabels(adminCtx(b),'department',{creates:[{key:'secret',companyId:hidden.id,name:'SECRET_B22_CODE',isGlobal:true}],updates:[]});
    await bulkSaveLabels(adminCtx(b),'department',{creates:[{key:'criteria',companyId:b.companyId,name:'SECRET_B22_CRITERIA_CODE',companyIds:[b.companyId,hidden.id]}],updates:[]});
    const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning();
    await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
    const ctx={...adminCtx(b),userId:user.id,grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
    const zip=await JSZip.loadAsync(await downloadSystemLabelTemplate(ctx,[b.companyId,hidden.id]));
    for(const [name,entry]of Object.entries(zip.files))if(/\.xml$/.test(name))expect(await entry.async('string')).not.toMatch(/SECRET_B22|SECRET_B22_CODE|SECRET_B22_CRITERIA_CODE/);
    await expect(downloadSystemLabelTemplate({...ctx,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]},[b.companyId])).rejects.toThrow('administrator');
  });
  it('rolls back initial inactive state and its audit when a later canonical create fails',async()=>{
    const bytes=book({division:[dataRow('division','B22_EARLIER','Inactive'),dataRow('division','B22_LATE_FAIL','Active')]}),preview=await previewSystemLabelImport(adminCtx(b),bytes);
    await owner.db.execute(sql`CREATE FUNCTION public.b22_labels_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.value='B22_LATE_FAIL' THEN RAISE EXCEPTION 'fictional refusal'; END IF; RETURN NEW; END $$`);
    await owner.db.execute(sql`CREATE TRIGGER b22_labels_refuse BEFORE INSERT ON profile_option FOR EACH ROW EXECUTE FUNCTION public.b22_labels_refuse()`);
    try{
      await expect(applySystemLabelImport(adminCtx(b),{bytes,token:preview.token})).rejects.toThrow();
      expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'B22_EARLIER'))).toEqual([]);
      expect(await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.payload}->>'value'='B22_EARLIER'`)).toEqual([]);
    }finally{
      await owner.db.execute(sql`DROP TRIGGER b22_labels_refuse ON profile_option`);await owner.db.execute(sql`DROP FUNCTION public.b22_labels_refuse()`);
    }
  });
  it('uses Personnel lifecycle truth for named Head samples and typed imports, including notice and probation',async()=>{
    const today=todayInKualaLumpur(),day=(offset:number)=>todayInKualaLumpur(new Date(Date.parse(`${today}T00:00:00+08:00`)+offset*86_400_000));
    const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional named Head',primaryEmail:'fictional-head@example.invalid'}).returning();
    const [employment]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:person.id,companyId:b.companyId,employeeCode:'000_HEAD_PERSON',hiredOn:day(-30)}).returning();
    await bulkSaveLabels(adminCtx(b),'department',{creates:[{key:'head-sample',companyId:b.companyId,name:'000_HEAD_SAMPLE',headEmploymentId:employment.id,companyIds:[b.companyId]}],updates:[]});
    const cases:{name:string;fields:EmploymentStatusInput;employed:boolean;futureHire?:boolean}[]=[
      {name:'confirmed',fields:{},employed:true},
      {name:'probation',fields:{probationEndDate:day(30)},employed:true},
      {name:'serving notice',fields:{resignationDate:day(30)},employed:true},
      {name:'resigned today with no terminatedOn',fields:{resignationDate:today},employed:false},
      {name:'last working day today with no terminatedOn',fields:{lastWorkingDate:today,resignationDate:day(30)},employed:false},
      {name:'terminated today',fields:{terminatedOn:today},employed:false},
      {name:'blacklisted',fields:{blacklistedAt:today},employed:false},
      {name:'not yet hired',fields:{},employed:false,futureHire:true},
    ];
    for(const [index,testCase]of cases.entries()){
      const fields={resignationDate:null,lastWorkingDate:null,terminatedOn:null,blacklistedAt:null,probationEndDate:null,provisionalEndOn:null,confirmationDate:null,finalConfirmationDate:null,...testCase.fields};
      const status=deriveEmploymentStatus(fields,today);
      expect(!testCase.futureHire&&['active','active_serving_notice','probation'].includes(status),testCase.name).toBe(testCase.employed);
      await owner.db.update(s.employment).set({...fields,hiredOn:day(testCase.futureHire?1:-30)}).where(eq(s.employment.id,employment.id));
      const wb=XLSX.read(await downloadSystemLabelTemplate(adminCtx(b),[b.companyId]),{type:'buffer'}),sample=XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Sample,{header:1,raw:false});
      const row=sample.find(row=>row.includes('000_HEAD_SAMPLE'));expect(row,testCase.name).toBeDefined();
      expect(row!.includes('000_HEAD_PERSON — Fictional named Head'),testCase.name).toBe(testCase.employed);
      const bytes=book({department:[{...dataRow('department',`HEAD_CASE_${index}`,'Active'),'Head Employee Code':'000_HEAD_PERSON — Fictional named Head'}]}),preview=await previewSystemLabelImport(adminCtx(b),bytes);
      expect(preview.valid,testCase.name).toBe(testCase.employed);
      if(testCase.employed){
        expect(preview.rows[0].after['Head Employee Code']).toBe('000_HEAD_PERSON');
        await applySystemLabelImport(adminCtx(b),{bytes,token:preview.token});
        const [saved]=await owner.db.select().from(s.department).where(eq(s.department.name,`HEAD_CASE_${index}`));expect(saved.headEmploymentId).toBe(employment.id);
      }else expect(preview.rows[0]).toMatchObject({reason:'invalidHeadEmployee',outcome:'error',selected:false});
    }
  });
});
