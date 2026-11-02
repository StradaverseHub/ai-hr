import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {renderToStaticMarkup} from 'react-dom/server';
import {PDFDocument,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {withTenant,type SessionContext} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {auditEvents} from '../core/read';
import {adminCtx,migrateTestDb,resetDb,seedBase,closeAll,owner,type Base} from './harness';
const auth=vi.hoisted(()=>({session:{} as SessionContext}));
vi.mock('../lib/session',()=>({getSession:async()=>auth.session}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
const {GET}=await import('../app/admin/audit/export/route');
const {AuditTable}=await import('../components/audit-table');
let b:Base,scoped:SessionContext,id:string;
const note='PRIVATEANOMALYNOTE71329';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const a=adminCtx(b),subject=await hireEmployee(a,{person:{fullName:'Audit private subject',primaryEmail:'audit-private@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Other audit scope'}).returning();
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:null}).returning();
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:company.id});
 scoped={tenantId:b.tenantId,userId:user.id,grants:[{role:'hr_admin',companyId:company.id}]};id=randomUUID();
 await withTenant(a,tx=>appendEvent(tx,{tenantId:b.tenantId,aggregateType:'payslip',aggregateId:id,eventType:'payroll.anomaly.resolved',actor:actorOf(a),subjectEmploymentId:subject.employmentId,payload:{resolution:'accepted',note}}));
});
async function exported(ctx:SessionContext,format:string){
 auth.session=ctx;const response=await GET(new Request(`http://localhost/admin/audit/export?record=${id}&format=${format}`));
 expect(response.status).toBe(200);
 if(format!=='pdf')return response.text();
 const pdf=await PDFDocument.load(await response.arrayBuffer());let text='';
 for(const [,object] of pdf.context.enumerateIndirectObjects())if(object instanceof PDFRawStream){
  const stream=Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
  for(const match of stream.matchAll(/<([A-Fa-f0-9]+)>/g))text+=Buffer.from(match[1],'hex').toString('latin1');
 }
 return text;
}
it('scoped HTML contains no other-company anomaly working note while authorized HTML retains it',async()=>{
 const authorized=await auditEvents(adminCtx(b),{aggregateId:id});expect(authorized).toHaveLength(1);
 expect(renderToStaticMarkup(await AuditTable({rows:authorized,nowMs:Date.now()}))).toContain(note);
 expect(renderToStaticMarkup(await AuditTable({rows:await auditEvents(scoped,{aggregateId:id}),nowMs:Date.now()}))).not.toContain(note);
});
it.each(['csv','xlsx','pdf'])('actual %s export protects private notes and retains authorized evidence',async format=>{
 expect(await exported(adminCtx(b),format)).toContain(note);
 expect(await exported(scoped,format)).not.toContain(note);
});
