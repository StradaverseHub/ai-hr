import ms from '../messages/ms.json';
import {invitationEmailContent,recoveryEmailContent} from '../lib/account-email-content';
import {describe,it,expect} from 'vitest';
import {emailDocument,defaultEmailDocument,emailKinds,type EmailDocument} from '../lib/email-design/model';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
import {renderEmailDesign} from '../lib/email-design/render';
import {validateEmailAsset} from '../lib/email-design/assets';
const system={subject:'Account invitation',text:'Open your account.\nhttps://example.com/activate\nExpires in seven days.',link:'https://example.com/activate'};
const id='10000000-0000-4000-8000-000000000001';
const design=():EmailDocument=>({...defaultEmailDocument('invitation'),blocks:[{id,type:'text',heading:'Hello {first_name}',runs:[{text:'Welcome to {company_name}',bold:true}],style:{}},...defaultEmailDocument('invitation').blocks]});
describe('validated email designs',()=>{
 it('requires one immutable system block and rejects disguised HTML, styling and unknown props',()=>{
  const doc=design();expect(emailDocument.parse(doc)).toEqual(doc);
  expect(emailDocument.safeParse({...doc,blocks:doc.blocks.filter(block=>block.type!=='system')}).success).toBe(false);
  expect(emailDocument.safeParse({...doc,blocks:[...doc.blocks,{...doc.blocks[2],id:'10000000-0000-4000-8000-000000000002'}]}).success).toBe(false);
  for(const bad of [{...doc.blocks[2],href:'https://evil.example/'},{...doc.blocks[2],text:'Your token expires never'},{...doc.blocks[2],style:{color:'red;display:none'}},{...doc.blocks[2],style:{padding:0}}])expect(emailDocument.safeParse({...doc,blocks:[bad]}).success).toBe(false);
  expect(emailDocument.safeParse({...doc,rawHtml:'<script>alert(1)</script>'}).success).toBe(false);
 });
 it('rejects unsafe links, duplicate ids, unknown placeholders and mismatched kinds',()=>{
  const doc=design();
  for(const href of ['javascript:alert(1)','http://example.com','data:text/html,hi','https://user:pass@example.com'])expect(emailDocument.safeParse({...doc,blocks:[...doc.blocks,{id:'10000000-0000-4000-8000-000000000002',type:'button',label:'Click',href,style:{}}]}).success).toBe(false);
  expect(emailDocument.safeParse({...doc,blocks:[...doc.blocks,doc.blocks[0]]}).success).toBe(false);
  expect(emailDocument.safeParse({...doc,subject:'{payroll_amount}'}).success).toBe(false);
  expect(()=>renderEmailDesign(doc,'recovery','en',system)).toThrow('Wrong email design');
 });
 it('escapes every text and detail while retaining the exact code-owned content in HTML and plain text',()=>{
  const doc=design(),data={first_name:'<img src=x onerror=alert(1)>',company_name:'A & B'};
  const output=renderEmailDesign(doc,'invitation','en',system,data);
  expect(output.html).toContain('&lt;img src=x onerror=alert(1)&gt;');expect(output.html).toContain('A &amp; B');expect(output.html).not.toContain('<img src=x');
  expect(output.text).toContain('A & B');expect(output.text).toContain(system.text);expect(output.html).toContain('<a href="https://example.com/activate">');
  expect(output.html).toContain('role="presentation"');expect(output.html).toContain('max-width:600px');
  // Preview and send use this exact deterministic function, including the text alternative.
  expect(renderEmailDesign(doc,'invitation','en',system,data)).toEqual(output);
 });
 it('renders the code-owned account action as a button while keeping its exact destination in both alternatives',()=>{
  const result=renderEmailDesign(null,'invitation','en',{...system,buttonLabel:'Activate my account'});
  expect(result.html).toContain('>Activate my account</a>');expect(result.html).toContain('href="https://example.com/activate"');expect(result.html).toContain('display:inline-block');expect(result.text).toContain(system.link);expect(result.text).toContain('Expires in seven days.');
 });
 it('applies size, alignment and spacing even when the default font is unchanged',()=>{
  const doc=design();doc.blocks[0].style={size:24,align:'right',padding:40};
  const html=renderEmailDesign(doc,'invitation','en',system).html;
  expect(html).toContain('font-size:24px;text-align:right;padding:40px;');
 });
 it('makes the isolated sender reject malformed design documents and wrong bindings',()=>{
  const mail={category:'leave' as const,locale:'en' as const,link:'https://example.com/app',action:true,messageId:'<fixture@example.com>'};
  expect(()=>workflowEmailMessage({...mail,design:{kind:'workflow.leave',locale:'en',document:{rawHtml:'<script/>'} as never}})).toThrow();
  expect(()=>workflowEmailMessage({...mail,design:{kind:'invitation',locale:'en',document:defaultEmailDocument('invitation')}})).toThrow('binding changed');
 });
 it('keeps an unedited assessment language on its system wording instead of an English design projection',()=>{
  const mail={category:'performance' as const,locale:'ms' as const,link:'https://example.com/app',action:true,messageId:'<fixture@example.com>',assessmentTasks:[{key:'own_results' as const,count:1,closesAt:null}],assessmentWords:{subject:'Fictional English custom subject',opening:'Fictional English custom opening'}};
  const result=workflowEmailMessage({...mail,design:{kind:'assessment_reminder',locale:'ms',document:null}});
  expect(result.subject).toBe(ms.workflowEmail.assessmentReminder.subject.replace('{count}','1'));expect(result.text).toContain(ms.workflowEmail.assessmentReminder.opening);expect(result.text).not.toContain(mail.assessmentWords.opening);
 });
 it('provides safe defaults for every known kind and preserves all system wording',()=>{
  for(const kind of emailKinds){const message=renderEmailDesign(null,kind,'ms',system);expect(message.subject).toBe(system.subject);expect(message.text).toContain(system.text);expect(message.html).toContain('lang="ms"');}
 });
 it('generates localized protected account blocks without changing their code-owned destinations',()=>{
  for(const locale of ['en','ms','zh','vi','ta','th'] as const){
   const invitation=invitationEmailContent('FICTIONAL','https://example.com/activate',locale),recovery=recoveryEmailContent('https://example.com/reset',locale);
   expect(invitation.text).toContain('FICTIONAL');expect(invitation.text).toContain('https://example.com/activate');expect(recovery.text).toContain('https://example.com/reset');
   if(locale!=='en'){expect(invitation.subject).not.toBe(invitationEmailContent('FICTIONAL','https://example.com/activate').subject);expect(recovery.subject).not.toBe(recoveryEmailContent('https://example.com/reset').subject);}
  }
 });
 it('accepts bounded raster assets and rejects a forged type or excessive size',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=','base64');
  expect(await validateEmailAsset(png,'image/png')).toEqual({width:1,height:1});
  await expect(validateEmailAsset(png,'image/jpeg')).rejects.toThrow();
  await expect(validateEmailAsset(Buffer.from('<svg><script/></svg>'),'image/png')).rejects.toThrow();
  await expect(validateEmailAsset(new Uint8Array(2*1024*1024+1),'image/png')).rejects.toThrow();
 });
});
