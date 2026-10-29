import {describe,it,expect} from 'vitest';
import {assessmentReminderWordsSchema,fillAssessmentReminderWords} from '../lib/assessment-reminder-mail';
import {assessmentReminderMessage} from '../lib/assessment-reminder-message';
import {defaultEmailDocument,type EmailDesignEnvelope} from '../lib/email-design/model';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
describe('saved reminder wording and exact preview renderer',()=>{
 it('fills only the four source placeholders and preserves unknown literal braces',()=>{
  const words={subject:'{first_name}: {count} {things} waiting — {cycle}',opening:'Hello {first_name}. Review {cycle}. {unknown}'};
  expect(fillAssessmentReminderWords(words,"o'CONNOR Smith",'Annual review',1)).toEqual({subject:"O'Connor: 1 thing is waiting — Annual review",opening:"Hello O'Connor. Review Annual review. {unknown}"});
  expect(fillAssessmentReminderWords(words,'','Cycle',2)?.subject).toBe('There: 2 things are waiting — Cycle');expect(fillAssessmentReminderWords(null,'A','Cycle',1)).toBeNull();
  expect(fillAssessmentReminderWords(words,'A','Cycle\r\nBcc: external',1)?.subject).not.toMatch(/[\r\n]/);
 });
 it('enforces source template limits and refuses empty wording and mail-header injection',()=>{
  for(const patch of [{subject:''},{opening:''},{subject:'x'.repeat(201)},{opening:'x'.repeat(501)},{subject:'Hello\r\nBcc: external'}])expect(assessmentReminderWordsSchema.safeParse({subject:'Review',opening:'Open your review',...patch}).success).toBe(false);
 });
 it('uses each recipient-bound localized custom layout identically for preview and delivery without leaking prepared English wording',()=>{
  const tasks=[{key:'own_competency' as const,count:1,closesAt:null}],words={subject:'LEGACY ENGLISH SUBJECT',opening:'LEGACY ENGLISH OPENING'},link='https://hr.test/performance/workspace';
  for(const locale of ['en','ms','zh','vi','ta','th'] as const){
   const base=defaultEmailDocument('assessment_reminder'),opening=`${locale} <script>alert(1)</script> & {first_name}`;
   const design:EmailDesignEnvelope={kind:'assessment_reminder',locale,document:{...base,subject:`${locale} {cycle} {count}`,background:'#123456',blocks:[base.blocks[0],{id:'00000000-0000-4000-8000-000000000003',type:'text',heading:`${locale} heading`,runs:[{text:opening}],style:{}},base.blocks[1]]},data:{first_name:'Fictional <Alex>',cycle:'<Annual>',count:'1',things:'thing is'}};
   const preview=assessmentReminderMessage({tasks,words},locale,link,design),actual=workflowEmailMessage({category:'performance',locale,link,action:true,messageId:'fixture',assessmentTasks:tasks,assessmentWords:words,design});
   expect(preview).toEqual(actual);expect(preview.subject).toBe(`${locale} <Annual> 1`);expect(preview.html).toContain('#123456');expect(preview.html).toContain(`${locale} heading`);expect(preview.html).toContain('&lt;script&gt;');expect(preview.html).toContain('Fictional &lt;Alex&gt;');expect(preview.html).not.toContain('<script>');expect(preview.text).toContain(`${locale} <script>alert(1)</script> & Fictional <Alex>`);expect(preview.text).not.toContain('LEGACY ENGLISH');expect(preview.html).not.toContain('LEGACY ENGLISH');expect(preview.text).toContain(link);
  }
 });
 it('refuses a design for another recipient language or mail kind before rendering',()=>{
  const mail={tasks:[{key:'own_competency' as const,count:1,closesAt:null}],words:null};
  expect(()=>assessmentReminderMessage(mail,'ms','https://hr.test/performance/workspace',{kind:'assessment_reminder',locale:'en',document:null})).toThrow('binding');
  expect(()=>assessmentReminderMessage(mail,'en','https://hr.test/performance/workspace',{kind:'invitation',locale:'en',document:null})).toThrow('binding');
 });
 it('uses identical escaped HTML and text for previews and actual mail in all six languages',()=>{
  const tasks=[{key:'own_competency' as const,count:1,closesAt:null}],words={subject:'Review <Annual>',opening:'Hello <script>alert(1)</script> & welcome'};
  for(const locale of ['en','ms','zh','vi','ta','th'] as const){
   const preview=assessmentReminderMessage({tasks,words},locale,'https://hr.test/performance/workspace'),mail=workflowEmailMessage({category:'performance',locale,link:'https://hr.test/performance/workspace',action:true,messageId:'fixture',assessmentTasks:tasks,assessmentWords:words});
   expect(preview).toEqual(mail);expect(preview.subject).toBe(words.subject);expect(preview.html).not.toContain('<script>');expect(preview.html).toContain('&lt;script&gt;');expect(preview.text).toContain(words.opening);
  }
 });
});
