import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {convertProbationEmail,parseProbationEmailDefinition,probationEmailLegacyBody,renderProbationEmail} from '../lib/automation/probation-email-definition';
import {PROBATION_DEFAULTS} from '../app/automation/probation-defaults';
import {fillAutomationMergeFields} from '../lib/automation/email';

describe('Probation email conversion keeps the canonical words and field semantics',()=>{
 it('converts all four shipped emails with exactly the same text and no double-brace debris',()=>{
  expect(PROBATION_DEFAULTS.emailTemplates).toHaveLength(4);
  for(const template of PROBATION_DEFAULTS.emailTemplates){
   const converted=convertProbationEmail(template);expect(converted.state,template.name).toBe('ready');
   if(converted.state!=='ready')throw new Error(template.name);
   const values=Object.fromEntries([...template.body.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map(match=>[match[1],`Fictional ${match[1]} <&>`]));
   expect(renderProbationEmail(converted.definition,values).text).toBe(fillAutomationMergeFields(template.body.replace(/\r\n?/g,'\n'),values));
   expect(probationEmailLegacyBody(converted.definition.bodyDoc)).toBe(template.body.replace(/\r\n?/g,'\n').replace(/\{\{\s*([^{}\s]+)\s*\}\}/g,'{{$1}}'));
  }
 });
 it('keeps the original renderer for any unknown subject or body token without partially converting',()=>{
  expect(convertProbationEmail({subject:'{{unknown.subject}}',body:'Hello {{employee.name}} {{unknown.body}}'})).toEqual({state:'legacy',fields:['unknown.subject','unknown.body']});
 });
 it('preserves whitespace, blank lines and literal brackets without interpreting HTML',()=>{
  const source='  <p>Hello</p>\r\n\r\n\r\n{{employee.name}} & {literal}\n';
  const converted=convertProbationEmail({subject:'Subject',body:source});if(converted.state!=='ready')throw new Error('conversion');
  const rendered=renderProbationEmail(converted.definition,{'employee.name':'<script>alert("x")</script>'});
  expect(rendered.text).toBe('  <p>Hello</p>\n\n\n<script>alert("x")</script> & {literal}\n');
  expect(rendered.html).not.toContain('<script>');expect(rendered.html).toContain('&lt;script&gt;');
 });
 it('refuses missing values instead of sending empty fields and refuses sensitive or unknown nodes',()=>{
  const converted=convertProbationEmail({subject:'Subject',body:'{{employee.name}}'});if(converted.state!=='ready')throw new Error('conversion');
  expect(()=>renderProbationEmail(converted.definition,{})).toThrow('employee.name');
  expect(()=>parseProbationEmailDefinition({...converted.definition,bodyDoc:{type:'doc',content:[{type:'paragraph',content:[{type:'field',attrs:{key:'bankAccount'}}]}]}})).toThrow();
  expect(()=>parseProbationEmailDefinition({...converted.definition,links:['11111111-1111-4111-8111-111111111111']})).toThrow('Probation document');
 });
});

it('refuses shared attachments over the aggregate private delivery budget',()=>{
 const converted=convertProbationEmail({subject:'Subject',body:'Body'});if(converted.state!=='ready')throw new Error('conversion');
 const file=()=>({id:randomUUID(),kind:'file',name:'Fictional.pdf',mimeType:'application/pdf',size:8_000_000,contentHash:'a'.repeat(64),at:'2026-11-18T00:00:00.000Z',by:'Fictional HR'});
 expect(()=>parseProbationEmailDefinition({...converted.definition,files:[file(),file(),file()]})).toThrow('20 MB');
 expect(()=>parseProbationEmailDefinition({...converted.definition,files:Array.from({length:20},()=>({...file(),size:1})),images:[{...file(),kind:'image',alt:'Fictional image',size:1}]})).toThrow('20 files');
});
