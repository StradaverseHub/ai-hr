import {describe,expect,it,vi} from 'vitest';
import type {Document,EmailAsset} from '../lib/lifecycle-v9-model';
import type {AutomationEmailContent,AutomationMailTarget} from '../lib/automation-email-ipc';
import {validateAutomationEmailContent} from '../lib/automation-email-content-policy';
import {automationEmailContent} from '../lib/automation-email-content';

vi.mock('../lib/lifecycle-v9-pdf',()=>({renderV9DocumentPdf:vi.fn(async()=>({bytes:new Uint8Array([37,80,68,70])}))}));
const doc=():Document=>({id:'letter-1',templateId:'retention',version:1,name:'Retention offer',status:'signed',blocks:[],fields:[],values:{},edits:{},mergeValues:{'employee.name':'Fictional employee'},hrSignature:null,employeeSignature:null,createdAt:'2026-11-16T08:00:00Z',sentAt:null});
const snapshot=():AutomationEmailContent=>({number:'RSN-0001',emailTemplateId:'email-1',documents:[doc()],pdfDocumentIds:['letter-1'],linkDocumentIds:['letter-1']});
const target=(content?:AutomationEmailContent):AutomationMailTarget=>({id:'delivery-1',tenantId:'tenant-1',module:'off',subjectId:'case-1',bindings:[],payload:{version:1,module:'off',subjectId:'case-1',linkPath:'/lifecycle/resignations/case-1',content,mail:{id:'mail-1',to:['employee-1'],cc:[],subject:'Your letter',body:'Open {{case.link}}',delivery:{version:1,sender:'noreply'}}}});
const empty=()=>({files:vi.fn(async()=>[]),assets:vi.fn(async()=>[])});
const asset=():EmailAsset=>({id:'image-1',kind:'image',name:'terms.png',mimeType:'image/png',size:4,contentHash:'a'.repeat(64),at:'2026-11-16T08:00:00Z',by:'fictional-hr',alt:'Terms of the offer'});

describe('Frozen resignation email content',()=>{
 it('keeps existing plain workflow mail unchanged apart from the canonical case link',async()=>{
  const input=target();input.module='probation';input.payload.module='probation';const read=empty();
  expect(await automationEmailContent(input,'https://mail.example',read)).toEqual({text:'Open https://mail.example/lifecycle/resignations/case-1',attachments:[]});
  expect(read.files).not.toHaveBeenCalled();expect(read.assets).not.toHaveBeenCalled();
 });
 it('renders only signed frozen documents and creates case-specific personal links',async()=>{
  const out=await automationEmailContent(target(snapshot()),'https://mail.example',empty());
  expect(out.text).toContain('Retention offer: https://mail.example/lifecycle/resignations/case-1?document=letter-1');
  expect(out.attachments).toEqual([expect.objectContaining({filename:'Retention offer.pdf',contentType:'application/pdf',bytes:new Uint8Array([37,80,68,70])})]);
 });
 it('refuses unsigned, missing or duplicate document references before reading any file bytes',async()=>{
  const unsigned=snapshot();unsigned.documents[0].status='draft';
  const missing=snapshot();missing.pdfDocumentIds=['other-case'];
  const duplicate=snapshot();duplicate.pdfDocumentIds.push('letter-1');
  for(const content of [unsigned,missing,duplicate])expect(()=>validateAutomationEmailContent(content)).toThrow();
  const read=empty();await expect(automationEmailContent(target(unsigned),'https://mail.example',read)).rejects.toThrow();
  expect(read.assets).not.toHaveBeenCalled();expect(read.files).not.toHaveBeenCalled();
 });
 it('does not enable rich content for other modules',async()=>{
  const input=target(snapshot());input.module='probation';
  await expect(automationEmailContent(input,'https://mail.example',empty())).rejects.toThrow('does not support');
 });
 it('requires the original template, alt text and exact asset descriptors and byte length',async()=>{
  const content=snapshot();content.assets=[asset()];
  expect(()=>validateAutomationEmailContent({...content,emailTemplateId:undefined})).toThrow();
  expect(()=>validateAutomationEmailContent({...content,assets:[{...asset(),alt:''}]})).toThrow();
  const read={files:vi.fn(async()=>[]),assets:vi.fn(async()=>[{id:'image-1',kind:'image',filename:'terms.png',mime_type:'image/png',content_hash:'b'.repeat(64),bytes:'AQIDBA=='}])};
  await expect(automationEmailContent(target(content),'https://mail.example',read)).rejects.toThrow('asset changed');
  read.assets.mockResolvedValue([{id:'image-1',kind:'image',filename:'terms.png',mime_type:'image/png',content_hash:'a'.repeat(64),bytes:'AQI='}]);
  await expect(automationEmailContent(target(content),'https://mail.example',read)).rejects.toThrow('asset changed');
 });
 it('refuses case-file digest changes and sanitizes rich message content before SMTP',async()=>{
  const content=snapshot();content.files=[{id:'file-1',storageId:'file-1',name:'schedule.txt',contentHash:'c'.repeat(64)}];
  const read={files:vi.fn(async()=>[{id:'file-1',filename:'schedule.txt',mime_type:'text/plain',content_hash:'d'.repeat(64),bytes:'dGVzdA=='}]),assets:vi.fn(async()=>[])};
  await expect(automationEmailContent(target(content),'https://mail.example',read)).rejects.toThrow('case file changed');
  content.files=[];content.html='<p>Hello</p><script>alert(1)</script>';
  const out=await automationEmailContent(target(content),'https://mail.example',read);
  expect(out.html).toContain('Hello');expect(out.html).not.toContain('<script');
 });
});
