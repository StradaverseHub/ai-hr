import {describe,it,expect} from 'vitest';
import {automationEmailAttachmentSettingsSchema} from '../lib/automation-email-assets';
import {fillAutomationMergeFields} from '../lib/automation/email';
import {automationEmailContent} from '../lib/automation-email-content';
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
 it('renders only supplied immutable image references and installation-owned document links',()=>{
  const imageId='a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6',templateId='b1b2c3d4-1111-4111-8111-a1b2c3d4e5f6',documentId='c1b2c3d4-1111-4111-8111-a1b2c3d4e5f6';
  const richBody={doc:{type:'doc' as const,content:[{type:'paragraph' as const,content:[{type:'image' as const,attrs:{assetId:imageId,alt:'Company logo'}},{type:'text' as const,text:'Open your document',marks:[{type:'link' as const,attrs:{kind:'document' as const,documentId:templateId}}]}]}]},values:{}};
  expect(()=>automationEmailContent({module:'contract_staff',origin:'https://mail.example.test',linkPath:'/lifecycle/contracts/example',body:'',richBody})).toThrow();
  const content=automationEmailContent({module:'contract_staff',origin:'https://mail.example.test',linkPath:'/lifecycle/contracts/example',body:'',richBody,assets:[{id:imageId,kind:'image',name:'logo.png',alt:'Company logo',mimeType:'image/png',size:24,contentHash:'a'.repeat(64),at:'2026-11-17T00:00:00.000Z',by:'Author'}],documents:[{id:documentId,templateId,name:'Fictional document'}]});
  expect(content.html).toContain('cid:v9-image.'+imageId+'@aihr');expect(content.html).toContain('https://mail.example.test/lifecycle/contracts/letters/'+documentId);
  expect(content.text).toContain('Fictional document: https://mail.example.test/lifecycle/contracts/letters/'+documentId);expect(content.html).not.toContain('{{document-link:');
 });
});
