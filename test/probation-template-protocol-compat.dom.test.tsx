import {afterEach,beforeAll,afterAll,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import type {EmailBodyDoc} from '../lib/email-body/doc';
const actions=vi.hoisted(()=>({save:vi.fn(),history:vi.fn(),search:vi.fn(),test:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({saveEmailTemplateAction:actions.save,readEmailTemplateHistoryAction:actions.history,searchPeopleAction:actions.search,sendTestEmailAction:actions.test}));
// Exercise both real editor hosts and their save boundaries; rich text node editing is separately covered.
vi.mock('../components/email-body-editor',()=>({EmailBodyEditor:({value}:{value:EmailBodyDoc})=><output aria-label="Fictional retained rich body">{JSON.stringify(value)}</output>}));
import {ProbationTemplateSection} from '../app/automation/templates/probation-template-section';
const showModal=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal'),close=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});});
afterAll(()=>{if(showModal)Object.defineProperty(HTMLDialogElement.prototype,'showModal',showModal);else Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');if(close)Object.defineProperty(HTMLDialogElement.prototype,'close',close);else Reflect.deleteProperty(HTMLDialogElement.prototype,'close');});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.clearAllMocks();});
const documentId='10000000-0000-4000-8000-000000000004';
const bodyDoc:EmailBodyDoc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Retained fictional shared rich body'}]}]};
const base:AutomationEmailTemplate={id:'10000000-0000-4000-8000-000000000001',module:'probation',name:'Fictional saved email',active:true,subject:'Original fictional subject',body:'Retained fictional shared rich body',cc:[]};
function show(template:AutomationEmailTemplate){
 actions.save.mockResolvedValue({ok:true,result:{revision:3,warnings:[]}});actions.history.mockResolvedValue({ok:true,result:[]});
 render(<NextIntlClientProvider locale="en" messages={messages}><ProbationTemplateSection emails={[{template,revision:2,retired:false}]} refs={{routings:[],groups:[],people:[]}} documents={[{id:documentId,name:'Fictional retained letter',type:'Letter'}]}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Edit '+template.name}));
}
it('opens the existing shared rich editor from the new hub and preserves its body, receipts, slots and documents on save',async()=>{
 const template:AutomationEmailTemplate={...base,bodyDoc,assets:[{id:'10000000-0000-4000-8000-000000000002',kind:'image',name:'Fictional.png',mimeType:'image/png',size:10,contentHash:'a'.repeat(64),at:'2026-11-18T00:00:00.000Z',by:'Fictional HR',alt:'Fictional retained image'}],slots:[{id:'10000000-0000-4000-8000-000000000003',label:'Fictional per-person file',required:false}],documentIds:[documentId]};
 show(template);expect(screen.getAllByRole('dialog')).toHaveLength(1);
 fireEvent.change(screen.getByRole('textbox',{name:messages.automation.editor.subject}),{target:{value:'Reviewed fictional subject'}});
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent(screen.getByRole('dialog'),new Event('cancel',{cancelable:true,bubbles:true}));expect(confirm).toHaveBeenCalledOnce();expect(screen.getByRole('dialog')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:messages.automation.templates.save}));await waitFor(()=>expect(actions.save).toHaveBeenCalledOnce());
 const input=actions.save.mock.calls[0][0];expect(input.expectedRevision).toBe(2);expect(input.template).toEqual({...template,subject:'Reviewed fictional subject'});expect(input.template.definition).toBeUndefined();
});
it('keeps an existing probation definition in its own editor and saves the same definition and revision',async()=>{
 const definition={version:1 as const,bodyDoc,files:[],images:[],links:[],attachments:[],slots:[]};show({...base,definition});
 expect(screen.getAllByRole('dialog')).toHaveLength(1);expect(screen.getByRole('combobox',{name:'Module'})).toHaveValue('probation');
 fireEvent.change(screen.getByRole('textbox',{name:'Subject'}),{target:{value:'Reviewed definition subject'}});fireEvent.click(screen.getByRole('button',{name:'Save email'}));await waitFor(()=>expect(actions.save).toHaveBeenCalledOnce());
 expect(actions.save.mock.calls[0][0]).toMatchObject({expectedRevision:2,template:{id:base.id,module:'probation',subject:'Reviewed definition subject',definition}});expect(actions.save.mock.calls[0][0].template.bodyDoc).toBeUndefined();
});
