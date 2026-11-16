import {beforeEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {EmailEditor} from '../app/automation/templates/email-editor';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import type {EmailBodyDoc} from '../lib/email-body/doc';
const mocks=vi.hoisted(()=>({save:vi.fn(),test:vi.fn(),refresh:vi.fn(),focusCell:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/automation/actions',()=>({saveEmailTemplateAction:mocks.save,sendTestEmailAction:mocks.test,searchPeopleAction:vi.fn()}));
// Rich text editing and its schema have their own tests; this checks the host's save guard and focus handoff.
vi.mock('../components/email-body-editor',async()=>{
 const React=await import('react');
 return {EmailBodyEditor:React.forwardRef((_props,ref)=>{React.useImperativeHandle(ref,()=>({focusTableCell:mocks.focusCell}));return <div aria-label="Message editor"/>;})};
});
const id='11111111-1111-4111-8111-111111111111',documentId='22222222-2222-4222-8222-222222222222';
const base:AutomationEmailTemplate={id,module:'contract_staff',name:'Fictional contract email',active:true,subject:'Contract for {{employee.name}}',body:'New start {{contract.newStart}}',cc:[]};
const show=(template=base,revision=1)=>render(<NextIntlClientProvider locale="en" messages={messages}><EmailEditor initial={{template,revision,retired:false}} refs={{groups:[],routings:[],people:[]}} documents={[{id:documentId,name:'Fictional renewal letter'}]} onClose={vi.fn()}/></NextIntlClientProvider>);
beforeEach(()=>{vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,result:{revision:2,warnings:[]}});mocks.test.mockResolvedValue({ok:true,result:{deliveryId:id}});});
describe('Shared rich email editor host',()=>{
 it('shows a phone/plain-text preview with missing decision values and queues only an explicit saved-template self test',async()=>{
  show();await userEvent.click(screen.getByRole('tab',{name:'Preview'}));
  await userEvent.selectOptions(screen.getByLabelText('Sample person'),'noDecision');
  await userEvent.click(screen.getByRole('button',{name:'Phone'}));await userEvent.click(screen.getByRole('button',{name:'Plain text'}));
  expect(screen.getByRole('status')).toHaveTextContent('Missing values: New start date');expect(screen.getByText('New start [New start date]')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button',{name:'Send test to me'}));
  await waitFor(()=>expect(mocks.test).toHaveBeenCalledWith({templateId:id,revision:1,sample:'noDecision',requestId:expect.any(String)}));
  expect(mocks.test.mock.calls[0][0]).not.toHaveProperty('to');expect(mocks.test.mock.calls[0][0]).not.toHaveProperty('cc');expect(screen.getByText(/Test queued to your own verified sign-in email/)).toHaveTextContent('Default CC is not included');
 });
 it('warns about a wide table and offers Show me before accepting an empty table cell',async()=>{
  const bodyDoc:EmailBodyDoc={type:'doc',content:[{type:'table',attrs:{headerRow:false,widths:'equal'},content:[{type:'tableRow',content:Array.from({length:5},(_,index)=>({type:'tableCell' as const,content:[{type:'paragraph' as const,content:index?[{type:'text' as const,text:'Value '+index}]:[]}]}))}]}]};
  show({...base,bodyDoc});expect(screen.getByText(/5 or more columns are hard to read on phones/)).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText('Template name'));await userEvent.type(screen.getByLabelText('Template name'),'Updated fictional email');
  await userEvent.click(screen.getByRole('button',{name:'Save template'}));expect(mocks.save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button',{name:'Show me'}));await waitFor(()=>expect(mocks.focusCell).toHaveBeenCalledWith({table:0,row:0,column:0}));
  await userEvent.click(screen.getByRole('button',{name:'Save template'}));await userEvent.click(screen.getByRole('button',{name:'Save anyway'}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1));
 });
 it('adds a personal document and file slot to the shared template and requires saving before testing',async()=>{
  show();await userEvent.click(screen.getByRole('checkbox',{name:'Fictional renewal letter'}));
  await userEvent.click(screen.getByRole('button',{name:'Add a file per person'}));
  await userEvent.click(screen.getByRole('tab',{name:'Preview'}));expect(screen.getByRole('button',{name:'Send test to me'})).toBeDisabled();
  await userEvent.click(screen.getByRole('button',{name:'Save template'}));await waitFor(()=>expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0][0].template.documentIds).toEqual([documentId]);expect(mocks.save.mock.calls[0][0].template.slots).toEqual([{id:expect.any(String),label:'File for this person',required:false}]);
 });
});
