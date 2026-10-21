import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {kbDocument} from '../db/schema';
import {hireEmployee} from '../core/org';
import {archiveDocument,createArticle,searchHomeKnowledgeDocuments} from '../core/knowledge-base';
import {todayInKualaLumpur} from '../lib/hr-date';
import {HOME_SEARCH_RESULT_LIMIT} from '../lib/employee-home-search';

let b:Base;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{await closeAll();});
async function viewer(role:'employee'|'manager'):Promise<SessionContext>{
 const person=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home Reader',primaryEmail:`home-kb-${randomUUID()}@example.invalid`},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 return {tenantId:b.tenantId,userId:await createAppUser(b.tenantId,person.personId,role),personId:person.personId,roles:[role]};
}
describe('Home library search retains the canonical audience owner',()=>{
 it('filters audience, archive and tenant before returning titles, links or counts, with a true no-match',async()=>{
  const admin=adminCtx(b),employee=await viewer('employee'),manager=await viewer('manager');
  const all=await createArticle(admin,{title:'Handbook general',body:'Fictional published guidance',audience:'all'});
  const own=await createArticle(admin,{title:'Handbook employee',body:'Fictional published guidance',audience:'employee'});
  const management=await createArticle(admin,{title:'Handbook manager',body:'Fictional manager guidance',audience:'manager'});
  const privateDoc=await createArticle(admin,{title:'Handbook HR',body:'privatehrneedle',audience:'hr_admin'});
  const archived=await createArticle(admin,{title:'Handbook old',body:'Old guidance',audience:'employee'});
  await archiveDocument(admin,archived.id);
  const foreign=await seedBase();await createArticle(adminCtx(foreign),{title:'Handbook foreign',body:'foreignneedle',audience:'all'});
  const employeeRows=await searchHomeKnowledgeDocuments(employee,'handbook');
  expect(new Set(employeeRows.map(row=>row.id))).toEqual(new Set([all.id,own.id]));
  expect(new Set((await searchHomeKnowledgeDocuments(manager,'handbook')).map(row=>row.id)))
   .toEqual(new Set([all.id,own.id,management.id]));
  expect((await searchHomeKnowledgeDocuments(admin,'handbook')).map(row=>row.id)).toContain(privateDoc.id);
  for(const query of ['privatehrneedle','foreignneedle','noSuchFictionalGuide','% _'])
   expect(await searchHomeKnowledgeDocuments(employee,query)).toEqual([]);
  expect(await searchHomeKnowledgeDocuments({...employee,userId:undefined},'handbook')).toEqual([]);
 });
 it('matches localized title/body text in all six languages and exposes only metadata plus a bounded authored excerpt',async()=>{
  const article=await createArticle(adminCtx(b),{title:'Leave guide',body:'Fictional published explanation',audience:'employee'});
  const translated={ms:{title:'Panduan cuti',body:'Cara memohon cuti'},zh:{title:'休假指南',body:'提交休假申请'},
   ta:{title:'விடுப்பு வழிகாட்டி',body:'கோரிக்கையை சமர்ப்பிக்கும் முறை'},th:{title:'คู่มือวันลา',body:'วิธียื่นคำขอลา'},
   vi:{title:'Hướng dẫn nghỉ phép',body:'Cách gửi đơn nghỉ phép'}};
  await owner.db.update(kbDocument).set({i18n:translated}).where(eq(kbDocument.id,article.id));
  const employee=await viewer('employee');
  for(const [locale,query,title]of [['en','leave','Leave guide'],['ms','memohon','Panduan cuti'],['zh','提交','休假指南'],
   ['ta','சமர்ப்பிக்கும்','விடுப்பு வழிகாட்டி'],['th','ยื่น','คู่มือวันลา'],['vi','gửi','Hướng dẫn nghỉ phép']]){
   const rows=await searchHomeKnowledgeDocuments(employee,query,locale);
   expect(rows,locale).toHaveLength(1);expect(rows[0].title,locale).toBe(title);
   expect(Object.keys(rows[0]).sort(),locale).toEqual(['category','descriptionMarkdown','href','id','kind','title']);
   expect(rows[0].descriptionMarkdown,locale).toBe(locale==='en'?'Fictional published explanation':translated[locale as keyof typeof translated].body);
   expect(rows[0].href,locale).toBe(`/knowledge-base/${article.id}`);
  }
 });
 it('never returns the full article or internal source buffer beyond the bounded preview',async()=>{
  await createArticle(adminCtx(b),{title:'Excerpt boundary',body:'a'.repeat(240)+' HIDDEN_AFTER_PREVIEW',audience:'employee'});
  const rows=await searchHomeKnowledgeDocuments(await viewer('employee'),'boundary');
  expect(rows).toHaveLength(1);expect(rows[0].descriptionMarkdown).toBe('a'.repeat(240)+'…');
  expect(rows[0]).not.toHaveProperty('descriptionSource');expect(rows[0]).not.toHaveProperty('body');
  expect(JSON.stringify(rows)).not.toContain('HIDDEN_AFTER_PREVIEW');
 });
 it('bounds results and gives equal-ranked documents a deterministic title/id order',async()=>{
  const titles=Array.from({length:HOME_SEARCH_RESULT_LIMIT+2},(_,index)=>`Guide ${String(index).padStart(2,'0')}`);
  for(const title of titles)await createArticle(adminCtx(b),{title,body:'Fictional guidance',audience:'employee'});
  const employee=await viewer('employee');
  const first=await searchHomeKnowledgeDocuments(employee,'guide'),second=await searchHomeKnowledgeDocuments(employee,'guide');
  expect(first.map(row=>row.title)).toEqual(titles.slice(0,HOME_SEARCH_RESULT_LIMIT));
  expect(second).toEqual(first);
 });
});
