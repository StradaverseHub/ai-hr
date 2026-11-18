import {afterEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import type {EmailBodyDoc} from '../lib/email-body/doc';
const actions=vi.hoisted(()=>({save:vi.fn().mockResolvedValue({ok:true,result:{revision:2,warnings:[]}}),history:vi.fn().mockResolvedValue({ok:true,result:[]})}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({saveEmailTemplateAction:actions.save,readEmailTemplateHistoryAction:actions.history}));
// The real rich editor has separate behavioral coverage. This seam exercises its parent adapter's asynchronous draft ownership.
vi.mock('../components/email-body-editor',()=>({EmailBodyEditor:({value,onChange}:{value:EmailBodyDoc;onChange:(doc:EmailBodyDoc)=>void})=><textarea aria-label="Fixture rich body" value={JSON.stringify(value)} onChange={event=>onChange({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:event.target.value}]}]})}/>}));
import {ProbationEmailEditor} from '../app/automation/templates/probation-email-editor';
const initial={template:{id:'a0700000-0000-4000-8000-000000002002',module:'probation' as const,name:'Review form is open',active:true,subject:'Review {{employee.name}}',body:'Hello {{employee.name}}',cc:[]},revision:1,retired:false};
function fixture(over:Partial<typeof initial.template>={}){return render(<NextIntlClientProvider locale="en" messages={messages}><ProbationEmailEditor initial={{...initial,template:{...initial.template,...over}}} refs={{routings:[],groups:[],people:[]}} onClose={()=>{}}/></NextIntlClientProvider>);}
afterEach(()=>{vi.unstubAllGlobals();actions.save.mockClear();});

it('uses Probation fields and sample preview, preserves identity and excludes other module documents',async()=>{
 fixture();
 expect(screen.getByRole('combobox',{name:'Module'})).toHaveValue('probation');
 fireEvent.click(screen.getByRole('button',{name:'Insert field into Subject'}));
 expect(screen.getByRole('button',{name:/Outcome ·/})).toBeInTheDocument();
 expect(screen.queryByRole('button',{name:/bank|passport|tax/i})).toBeNull();
 fireEvent.click(screen.getByRole('tab',{name:'Preview'}));
 expect(screen.getByText('Hello Sample employee')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Save email'}));
 await waitFor(()=>expect(actions.save).toHaveBeenCalledOnce());
 expect(actions.save.mock.calls[0][0]).toMatchObject({expectedRevision:1,template:{id:initial.template.id,module:'probation',body:'Hello {{employee.name}}',definition:{version:1,bodyDoc:{type:'doc'}}}});
});
it('preserves a concurrent rich-body edit when a shared-file upload finishes',async()=>{
 let finish!:(value:unknown)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
 fixture();
 fireEvent.change(screen.getByLabelText('Upload a shared file'),{target:{files:[new File(['Fictional'],'Fictional handbook.txt')]}});
 fireEvent.change(screen.getByLabelText('Fixture rich body'),{target:{value:'Body edited while upload was pending'}});
 finish({ok:true,json:async()=>({asset:{id:'d682edb9-7a1c-49bd-a867-aacde369aa5c',kind:'file',name:'Fictional handbook.txt',mimeType:'text/plain',size:9,contentHash:'a'.repeat(64),at:'2026-11-18T00:00:00.000Z',by:'Fictional HR'}})});
 await screen.findByRole('link',{name:'Fictional handbook.txt'});
 fireEvent.click(screen.getByRole('button',{name:'Save email'}));await waitFor(()=>expect(actions.save).toHaveBeenCalledOnce());
 const template=actions.save.mock.calls[0][0].template;
 expect(template.body).toBe('Body edited while upload was pending');expect(template.definition.files).toHaveLength(1);
 expect(JSON.stringify(template.definition.bodyDoc)).toContain('Body edited while upload was pending');
});
it('names the unconverted email and field and saves it through its original legacy path',async()=>{
 fixture({body:'Keep {{unknown.field}} exactly'});
 expect(screen.getByText(/these fields could not be converted/)).toHaveTextContent('Review form is open');expect(screen.getByText(/these fields could not be converted/)).toHaveTextContent('{{unknown.field}}');
 expect(screen.queryByLabelText('Fixture rich body')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Save email'}));await waitFor(()=>expect(actions.save).toHaveBeenCalledOnce());
 expect(actions.save.mock.calls[0][0].template).toMatchObject({body:'Keep {{unknown.field}} exactly'});expect(actions.save.mock.calls[0][0].template.definition).toBeUndefined();
});
