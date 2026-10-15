import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importArchitecture, architectureHeaders } from '../packs/performance/onehr/architecture-model';
import { defaultPolicy } from '../packs/performance/onehr/model';
import { technicalProfilePlan } from '../packs/performance/onehr/career-model';
import framework from '../packs/performance/onehr/framework.json';
import { toCsv } from '../lib/csv';
import { buildXlsx, workbookToCsvTexts } from '../lib/spreadsheet';
const skill=(code:string,level:number,title='Analysis')=>['Finance','Analyst','12','Services','Finance','Analyst','High',code,title,'Technical','Finance',String(level),`Analyse at level ${level}`,'Accounting knowledge','Prepare the analysis'];
const sheets={Job_Profile:toCsv([architectureHeaders.Job_Profile,['Finance','Analyst','12','Services','Finance','Analyst','High','3']]),Job_Skills:toCsv([architectureHeaders.Job_Skills,skill('ANA-3',3),skill('ANA-4',4)])};
describe('source architecture workbook import',()=>{
 it('reads the source sheets, keeps proficiency data and derives the next level only when not explicitly current',()=>{
  const v=importArchitecture(defaultPolicy(framework),sheets,null,()=>randomUUID());
  expect(v).toMatchObject({skills:2,profiles:1,links:2,skipped:0});
  expect(v.policy.skills?.[0]).toMatchObject({id:'ANA-3',skillCode:'ANA-3',skillTitle:'Analysis',skillLevel:3,knowledge:'Accounting knowledge',ability:'Prepare the analysis'});
  expect(technicalProfilePlan(v.policy.profiles[0],v.policy.skills??[]).map(s=>s.future)).toEqual([false,false]);
  const one={...sheets,Job_Skills:toCsv([architectureHeaders.Job_Skills,skill('ANA-3',3)])};
  const next=importArchitecture(v.policy,one,null,()=>randomUUID());
  expect(next.policy.profiles[0].id).toBe(v.policy.profiles[0].id);
  expect(next.policy.profiles[0].competencies.map(c=>c.id)).toEqual(['ANA-3']);
  expect(technicalProfilePlan(next.policy.profiles[0],next.policy.skills??[]).map(s=>({id:s.id,future:s.future}))).toEqual([{id:'ANA-3',future:false},{id:'ANA-4',future:true}]);
 });
 it('matches role keys case-insensitively on reimport and preserves another company’s same-named profile',()=>{
  const company=randomUUID(),other=randomUUID(),p=defaultPolicy(framework);const first=importArchitecture(p,sheets,company,()=>randomUUID());
  first.policy.profiles.push({...first.policy.profiles[0],id:randomUUID(),companyId:other});
  const second=importArchitecture(first.policy,{...sheets,Job_Profile:sheets.Job_Profile.replace('Finance,Analyst,12','FINANCE,ANALYST,12')},company,()=>randomUUID());
  expect(second.policy.profiles).toHaveLength(2);expect(second.policy.profiles.find(p=>p.companyId===company)?.id).toBe(first.policy.profiles[0].id);
 });
 it('accepts roles found only in Job_Skills and rejects unusable or ambiguous headers and levels',()=>{
  expect(importArchitecture(defaultPolicy(framework),{...sheets,Job_Profile:''},null,()=>randomUUID()).profiles).toBe(1);
  for(const csv of ['', 'Skill Code,Skill Code\na,b',sheets.Job_Skills.replace(',3,Analyse',',unknown,Analyse')])expect(()=>importArchitecture(defaultPolicy(framework),{...sheets,Job_Skills:csv},null,()=>randomUUID())).toThrow();
 });
 it('uses the shared workbook decoder when either source sheet is first, without changing existing single-sheet behavior',async()=>{
  const bytes=await buildXlsx(architectureHeaders.Job_Skills,[skill('ANA-3',3)],{sheetName:'Job_Skills',extraSheets:[{name:'Job_Profile',rows:[architectureHeaders.Job_Profile,['Finance','Analyst','12']]}]});
  const decoded=await workbookToCsvTexts(bytes,['Job_Profile','Job_Skills'],true);
  expect(decoded.extra.Job_Skills).toContain('ANA-3');expect(decoded.extra.Job_Profile).toContain('Analyst');
  expect((await workbookToCsvTexts(bytes,['Job_Profile','Job_Skills'])).extra.Job_Skills).toBeUndefined();
 });
});
