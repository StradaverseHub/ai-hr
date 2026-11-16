import {describe,it,expect} from 'vitest';
import {automationEmailAttachmentSettingsSchema} from '../lib/automation-email-assets';
import {fillAutomationMergeFields} from '../lib/automation/email';
describe('Shared email attachment settings',()=>{
 it('does not resolve inherited object properties as merge fields',()=>{
  expect(fillAutomationMergeFields('{{constructor}} {{__proto__}} {{employee.name}}',{'employee.name':'Ali'})).toBe('{{constructor}} {{__proto__}} Ali');
  expect(fillAutomationMergeFields('{{constructor}}',JSON.parse('{"constructor":"Own value"}'))).toBe('Own value');
  expect(fillAutomationMergeFields('{{employee.name}} {{today}}',{'employee.name':'',today:null})).toBe('{{employee.name}} {{today}}');
 });
 it('refuses duplicate slots, unbounded files and inline non-images',()=>{
  const slot={id:'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6',label:'Voucher',required:true};
  expect(automationEmailAttachmentSettingsSchema.safeParse({assets:[],slots:[slot,slot],documentIds:[]}).success).toBe(false);
  const asset={id:slot.id,kind:'image',name:'wrong.pdf',mimeType:'application/pdf',size:42,contentHash:'a'.repeat(64),at:'2026-11-17T00:00:00.000Z',by:'Author'};
  expect(automationEmailAttachmentSettingsSchema.safeParse({assets:[asset],slots:[],documentIds:[]}).success).toBe(false);
  expect(automationEmailAttachmentSettingsSchema.safeParse({assets:[],slots:[slot],documentIds:[]}).success).toBe(true);
 });
});
