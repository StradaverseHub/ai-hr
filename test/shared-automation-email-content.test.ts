import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {sharedAutomationEmailContent} from '../lib/shared-automation-email-content';
import type {AutomationMailTarget} from '../lib/automation-email-ipc';
const id='10000000-0000-4000-8000-000000000001',letter='10000000-0000-4000-8000-000000000002',template='10000000-0000-4000-8000-000000000003';
const bytes=Buffer.from('Fictional native bytes'),asset={id,kind:'file' as const,name:'information.txt',mimeType:'text/plain',size:bytes.length,contentHash:createHash('sha256').update(bytes).digest('hex'),at:'2026-11-17T00:00:00.000Z',by:'Fictional author'};
const row={id,kind:'file',filename:asset.name,mime_type:asset.mimeType,bytes:bytes.toString('base64')};
function target(module:'contract_staff'|'probation'='contract_staff'):AutomationMailTarget{return {id,tenantId:id,module,subjectId:id,bindings:[],payload:{version:1,module,subjectId:id,linkPath:'/lifecycle/contracts/'+id,mail:{id,to:[id],cc:[],subject:'Fictional mail',body:'Your information.',delivery:{version:1,sender:'noreply',assets:[asset]}}}};}
describe('shared native private email content',()=>{
 for(const module of ['contract_staff','probation'] as const)it(`materializes ${module} bytes from the actual receipt`,async()=>{
  const content=await sharedAutomationEmailContent(target(module),'https://fictional.invalid',{assets:async()=>[row],documents:async()=>[]});
  expect(content.attachments).toEqual([{filename:asset.name,contentType:asset.mimeType,bytes}]);
 });
 it('adds the authorized personal document to HTML and plaintext, including when no body token was inserted',async()=>{
  const t=target(),document={id:letter,templateId:template,name:'Your form'};t.payload.mail.delivery.documents=[document];t.payload.mail.richBody={doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Your information.'}]}]},values:{}};
  const content=await sharedAutomationEmailContent(t,'https://fictional.invalid',{assets:async()=>[row],documents:async()=>[document]});
  expect(content.html).toContain('https://fictional.invalid/lifecycle/contracts/letters/'+letter);expect(content.text).toContain('Your form:');
  delete t.payload.mail.richBody;expect((await sharedAutomationEmailContent(t,'https://fictional.invalid',{assets:async()=>[row],documents:async()=>[document]})).text).toContain('/letters/'+letter);
 });
 it('embeds images using native CID, never filesystem or arbitrary URL attachments',async()=>{
  const t=target();t.payload.mail.delivery.assets=[{...asset,kind:'image',name:'logo.png',mimeType:'image/png'}];
  const content=await sharedAutomationEmailContent(t,'https://fictional.invalid',{assets:async()=>[{...row,kind:'image',filename:'logo.png',mime_type:'image/png'}],documents:async()=>[]});expect(content.attachments[0].cid).toBe(`v9-image.${id}@aihr`);
 });
 for(const failure of ['missing','changedBytes','changedName','deniedDocument'])it(`refuses ${failure} before producing transport content`,async()=>{
  const t=target();if(failure==='deniedDocument')t.payload.mail.delivery.documents=[{id:letter,templateId:template,name:'Your form'}];
  const stored=failure==='missing'?[]:[{...row,...(failure==='changedBytes'?{bytes:Buffer.from('changed').toString('base64')}:{}),...(failure==='changedName'?{filename:'changed.txt'}:{})}];
  await expect(sharedAutomationEmailContent(t,'https://fictional.invalid',{assets:async()=>stored,documents:async()=>null})).rejects.toThrow();
 });
});
