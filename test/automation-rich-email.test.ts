import {describe,expect,it} from 'vitest';
import {automationEmailBodyDoc,automationEmailBodyText,automationEmailTemplateProblems,renderAutomationEmailBody} from '../lib/automation/email';
import {CONTRACT_AUTOMATION_CATALOGUE as catalogue} from '../lib/automation/catalogues/contracts';

describe('shared rich email source',()=>{
 it('preserves shared merge fields on conversion and escapes merged content',()=>{
  const body='Dear {{employee.name}}\n\nYour contract {{contract.number}}';
  const doc=automationEmailBodyDoc({body});
  expect(automationEmailBodyText(doc)).toBe(body);
  const output=renderAutomationEmailBody({body,bodyDoc:doc},{'employee.name':'<script>alert(1)</script>','contract.number':'CN-123'});
  expect(output.html).toContain('&lt;script&gt;');
  expect(output.html).not.toContain('<script>');
  expect(output.text).toContain('CN-123');
 });
 it('refuses unavailable assets and unsafe links rather than dropping them on save',()=>{
  const doc=automationEmailBodyDoc({body:'Hello'});
  doc.content=[{type:'paragraph',content:[{type:'text',text:'Open',marks:[{type:'link',attrs:{kind:'web',href:'javascript:alert(1)'}}]}]}];
  const problems=automationEmailTemplateProblems({id:'x',module:'contract_staff',name:'Test',active:true,subject:'Test',body:'Open',bodyDoc:doc,cc:[]},catalogue,{routingExists:()=>false,groupExists:()=>false,personExists:()=>false});
  expect(problems).toContain('The rich email body contains invalid content or unavailable fields.');
 });
});
