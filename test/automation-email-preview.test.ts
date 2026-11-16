import {describe,expect,it} from 'vitest';
import {automationEmailPreview,automationEmailSampleValues} from '../lib/automation-email-preview';
import {CONTRACT_AUTOMATION_CATALOGUE as catalogue} from '../lib/automation/catalogues/contracts';
import type {AutomationEmailTemplate} from '../lib/automation/email';
const template:AutomationEmailTemplate={id:'fictional',module:'contract_staff',name:'Fictional preview',active:true,subject:'Contract for {{employee.name}}',body:'Dear {{employee.name}}\n\nNew start {{contract.newStart}}\nReason {{contract.reason}}',cc:[]};
describe('Shared email preview examples',()=>{
 it('renders a complete fictional employee and identifies decision fields unavailable before a decision',()=>{
  const complete=automationEmailPreview(template,catalogue,'complete');
  expect(complete.subject).toBe('Contract for Alex Tan');expect(complete.text).toContain('2027-01-01');expect(complete.missing).toEqual([]);
  const pending=automationEmailPreview(template,catalogue,'noDecision');
  expect(pending.missing).toEqual(['contract.newStart','contract.reason']);expect(pending.text).toContain('[New start date]');expect(pending.text).not.toContain('Renewal agreed');
 });
 it('uses a local example link and exposes neither an actual case nor an arbitrary executable value',()=>{
  expect(automationEmailSampleValues(catalogue,'complete')['case.link']).toBe('#example-case');
  const output=automationEmailPreview({...template,body:'{{employee.name}} <script>alert(1)</script>'},catalogue,'complete');
  expect(output.html).not.toContain('<script>');expect(output.html).toContain('&lt;script&gt;');
 });
});
