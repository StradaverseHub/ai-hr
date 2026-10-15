import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import * as s from '../db/schema';
import { LABEL_IMPORT_DEFINITIONS,type LabelImportMode } from '../lib/system-label-definition';
import { applySystemLabelImport,downloadSystemLabelTemplate,previewSystemLabelImport } from '../core/system-label-import';
import { listProfileOptions } from '../core/profile-options';
import { labelIdsForCompany } from '../core/system-labels';
import { createCompany, createJobGrade } from '../core/admin';
import { createGradeGroup } from '../packs/leave/service';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const book=(data:Record<string,Record<string,string>[]>)=>{
  const wb=XLSX.utils.book_new();
  for(const [kind,rows]of Object.entries(data)){
    const d=LABEL_IMPORT_DEFINITIONS.find(x=>x.kind===kind)!;
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([d.columns,...rows.map(r=>d.columns.map(c=>(c==='Criteria'?(r.Criteria??(r.Scope==='global'?'global':'companies')):c==='Criteria Companies'?(r['Criteria Companies']??(r.Scope==='global'?'':[r.Company,r['Shared Companies']].filter(Boolean).join(';'))):r[c])??''))]),kind);
  }
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'}) as Buffer;
};
const apply=async(bytes:Buffer,mode:LabelImportMode='add',confirmed=false)=>{
  const preview=await previewSystemLabelImport(adminCtx(b),bytes,mode);
  expect(preview.rows.filter(r=>r.outcome==='error')).toEqual([]);
  return applySystemLabelImport(adminCtx(b),{bytes,mode,token:preview.token,confirmUpdates:confirmed});
};
describe('reviewed System Labels imports',()=>{
  it('imports all four real company mappings and all tenant organisation option categories; dropdown readers see them',async()=>{
    const data:Record<string,Record<string,string>[]>={};
    for(const d of LABEL_IMPORT_DEFINITIONS.filter(d=>d.kind!=='grades'&&d.kind!=='grade_groups'))data[d.kind]=[
      d.scope==='company'?{Company:b.companyId,Scope:'own',Code:'EXCEL_'+d.kind,Label:'Readable',Description:'Description'}:
        {Code:'EXCEL_'+d.kind,Label:'Readable',Description:'Description','Sort Order':'3'}];
    const bytes=book(data);expect(await apply(bytes)).toMatchObject({imported:12,updated:0,failed:0});
    expect(await apply(bytes)).toMatchObject({imported:0,skipped:12});
    const [department]=await owner.db.select().from(s.department).where(eq(s.department.name,'EXCEL_department'));
    const [position]=await owner.db.select().from(s.position).where(eq(s.position.title,'EXCEL_position'));
    const [cost]=await owner.db.select().from(s.costCenter).where(eq(s.costCenter.code,'EXCEL_cost_center'));
    expect(department).toMatchObject({label:'Readable',description:'Description'});expect(position.title).toBe('EXCEL_position');expect(cost.name).toBe('Description');
    expect(await labelIdsForCompany(adminCtx(b),'department',b.companyId)).toContain(department.id);
    expect((await listProfileOptions(adminCtx(b),'division')).map(r=>r.value)).toContain('EXCEL_division');
  });
  it('requires explicit Update Existing plus confirmation, previews before/after, and keeps the identifier',async()=>{
    const first=book({division:[{Code:'FIXED',Label:'Original'}]});await apply(first);
    const bytes=book({division:[{Code:'FIXED',Label:'Updated',Description:'Changed','Sort Order':'2'}]});
    expect((await previewSystemLabelImport(adminCtx(b),bytes,'add')).valid).toBe(false);
    const preview=await previewSystemLabelImport(adminCtx(b),bytes,'update');
    expect(preview.rows[0]).toMatchObject({outcome:'update',before:{Code:'FIXED',Label:'Original'},after:{Code:'FIXED',Label:'Updated'}});
    await expect(applySystemLabelImport(adminCtx(b),{bytes,mode:'update',token:preview.token,confirmUpdates:false})).rejects.toThrow('Confirm');
    expect(await apply(bytes,'update',true)).toMatchObject({updated:1});
    const [row]=await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'FIXED'));expect(row.value).toBe('FIXED');expect(row.label).toBe('Updated');
  });
  it('invalid rows prevent every otherwise valid row from saving, and changed previews are refused',async()=>{
    const bytes=book({division:[{Code:'VALID',Label:'Valid'},{Code:'',Label:'Invalid'}]});
    const preview=await previewSystemLabelImport(adminCtx(b),bytes,'add');expect(preview.valid).toBe(false);
    await expect(applySystemLabelImport(adminCtx(b),{bytes,mode:'add',token:preview.token,confirmUpdates:false})).rejects.toThrow('Correct every');
    expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'VALID'))).toEqual([]);
    const valid=book({division:[{Code:'VALID',Label:'Valid'}]});const stale=await previewSystemLabelImport(adminCtx(b),valid,'add');
    await apply(book({division:[{Code:'OTHER',Label:'Other'}]}));
    await expect(applySystemLabelImport(adminCtx(b),{bytes:valid,mode:'add',token:stale.token,confirmUpdates:false})).rejects.toThrow('changed since preview');
    expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'VALID'))).toEqual([]);
  });
  it('preserves company scope; missing or foreign companies cannot turn a row global',async()=>{
    for(const Company of ['',randomUUID()]){
      const preview=await previewSystemLabelImport(adminCtx(b),book({department:[{Company,Scope:'global',Code:'NO'}]}),'add');expect(preview.valid).toBe(false);
    }
    const other={...adminCtx(b),roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
    await expect(previewSystemLabelImport(other,book({division:[{Code:'FORBIDDEN'}]}),'add')).rejects.toThrow('administrator');
    await expect(downloadSystemLabelTemplate(other)).rejects.toThrow('administrator');
    const original=book({department:[{Company:b.companyId,Scope:'own',Code:'KEEP'}]});await apply(original);
    expect((await previewSystemLabelImport(adminCtx(b),book({department:[{Company:b.companyId,Criteria:'companies','Criteria Companies':'',Code:'KEEP'}]}),'update')).valid).toBe(false);
  });
  it('uses the grade and grade-group services without detaching existing membership',async()=>{
    await apply(book({grades:[{Code:'EXCEL_G1',Label:'Excel grade',Rank:'4'}]}));
    await apply(book({grade_groups:[{Name:'Excel group','Grade Codes':'EXCEL_G1'}]}));
    expect((await previewSystemLabelImport(adminCtx(b),book({grade_groups:[{Name:'Other group','Grade Codes':'EXCEL_G1'}]}),'add')).valid).toBe(false);
    expect((await previewSystemLabelImport(adminCtx(b),book({grade_groups:[{Name:'Unknown','Grade Codes':'UNKNOWN'}]}),'add')).valid).toBe(false);
    const [grade]=await owner.db.select().from(s.jobGrade).where(eq(s.jobGrade.code,'EXCEL_G1'));
    const members=await owner.db.select().from(s.gradeGroupMember).where(eq(s.gradeGroupMember.gradeId,grade.id));expect(members).toHaveLength(1);
    const archived=await createJobGrade(adminCtx(b),{code:'ARCHIVED',name:'Archived'});
    await owner.db.update(s.jobGrade).set({archivedAt:new Date()}).where(eq(s.jobGrade.id,archived.id));
    expect((await previewSystemLabelImport(adminCtx(b),book({grades:[{Code:'ARCHIVED',Label:'New'}]}),'add')).valid).toBe(false);
  });
  it('reports identical file duplicates as skipped and conflicting duplicates as errors',async()=>{
    const row={Code:'ONE',Label:'One'};
    expect(await apply(book({division:[row,row]}))).toMatchObject({imported:1,skipped:1});
    expect((await previewSystemLabelImport(adminCtx(b),book({division:[row,{...row,Label:'Different'}]}),'update')).valid).toBe(false);
  });
  it('shares only into permitted companies, enables sharing, and keeps Global visible through the existing resolver',async()=>{
    const other=await createCompany(adminCtx(b),{legalName:'Excel second company'});
    const [co]=await owner.db.select().from(s.company).where(eq(s.company.id,b.companyId));
    await apply(book({department:[{Company:co.legalName,Scope:'shared','Shared Companies':'Excel second company',Code:'SHARED'}]}));
    const [dep]=await owner.db.select().from(s.department).where(eq(s.department.name,'SHARED'));
    expect(await labelIdsForCompany(adminCtx(b),'department',other.id)).toContain(dep.id);
    const [shared]=await owner.db.select().from(s.company).where(eq(s.company.id,other.id));expect(shared.sharedSystemLabels).toBe(true);
    await apply(book({department:[{Company:co.legalName,Scope:'global',Code:'GLOBAL'}]}));
    const [global]=await owner.db.select().from(s.department).where(eq(s.department.name,'GLOBAL'));
    expect(await labelIdsForCompany(adminCtx(b),'department',other.id)).toContain(global.id);
    const scoped={...adminCtx(b),roles:['hr_admin'],grants:[{role:'hr_admin' as const,companyId:b.companyId}]};
    expect((await previewSystemLabelImport(scoped,book({department:[{Company:other.id,Scope:'own',Code:'NO'}]}),'add')).valid).toBe(false);
    expect((await previewSystemLabelImport(scoped,book({department:[{Company:b.companyId,Scope:'global',Code:'NO'}]}),'add')).valid).toBe(false);
  });
  it('rolls earlier writes and their audit events back if a later service fails at save time',async()=>{
    const bytes=book({division:[{Code:'EARLIER',Label:'Earlier'},{Code:'LATE_FAIL',Label:'Later'}]});
    const preview=await previewSystemLabelImport(adminCtx(b),bytes,'add');expect(preview.valid).toBe(true);
    await owner.db.execute(sql`CREATE FUNCTION public.board_four_refuse_label() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.value='LATE_FAIL' THEN RAISE EXCEPTION 'fixture refusal'; END IF; RETURN NEW; END $$`);
    await owner.db.execute(sql`CREATE TRIGGER board_four_refuse_label BEFORE INSERT ON profile_option FOR EACH ROW EXECUTE FUNCTION public.board_four_refuse_label()`);
    try {
      await expect(applySystemLabelImport(adminCtx(b),{bytes,mode:'add',token:preview.token,confirmUpdates:false})).rejects.toThrow();
      expect(await owner.db.select().from(s.profileOption).where(eq(s.profileOption.value,'EARLIER'))).toEqual([]);
      expect(await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.payload}->>'value'='EARLIER'`)).toEqual([]);
    } finally {
      await owner.db.execute(sql`DROP TRIGGER board_four_refuse_label ON profile_option`);
      await owner.db.execute(sql`DROP FUNCTION public.board_four_refuse_label()`);
    }
  });
});
