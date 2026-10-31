import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {useCallback,useState} from 'react';
import type {AttachmentChatTurn} from '../components/assistant/use-assistant-import';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {AssistantImportHandoffProvider,useAssistantImportHandoff,useAssistantImportIntake} from '../components/assistant/import-handoff';
import {AssistantFileImport} from '../components/assistant/file-import';
import {WorkspaceComposer} from '../components/assistant/workspace-composer';
import {captureImportDraft,IMPORT_TARGETS,importDraftCsv} from '../lib/assistant-import';
import {parseCsvRecords} from '../lib/csv';

const mocks=vi.hoisted(()=>({prepare:vi.fn(),read:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push})}));
vi.mock('../app/assistant/file-import-actions',()=>({prepareAssistantImportAction:mocks.prepare}));
vi.mock('../lib/assistant-import-file',()=>({readAssistantImportFile:mocks.read}));
const copy=en.assistant.fileImport;
const source='E001 -25.50';
const draft=captureImportDraft('payroll_history',source,{rows:[{cells:[{field:'employee_no',start:0,end:4},{field:'amount',start:5,end:11}]}]});
function wrap(ui:React.ReactNode=<AssistantFileImport/>){return render(<NextIntlClientProvider locale="en" messages={en}><AssistantImportHandoffProvider>{ui}</AssistantImportHandoffProvider></NextIntlClientProvider>);}
async function attach(){await screen.findByRole('button',{name:copy.attach});fireEvent.change(screen.getByLabelText(copy.attach,{selector:'input'}),{target:{files:[new File(['data'],'records.pdf')]}});await waitFor(()=>expect(screen.getAllByText('records.pdf').length).toBeGreaterThan(0));}
beforeEach(()=>{vi.resetAllMocks();mocks.read.mockResolvedValue({name:'records.pdf',parts:[{label:'records.pdf',text:source}]});mocks.prepare.mockResolvedValue({ok:true,draft});window.history.replaceState({},'', '/assistant');});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('source-bound extraction',()=>{
 it('bounds repeated evidence expansion before returning a draft',()=>{
  const rows=Array.from({length:200},(_,index)=>({cells:[{field:'amount',start:index,end:index+2000}]}));
  expect(()=>captureImportDraft('payroll_history','a'.repeat(2200),{rows})).toThrow('Draft too large');
 });
 it('uses whole spreadsheet cells, preserving CSV quotes, line breaks and signed amounts',()=>{
  const source='employee_no,amount,notes\r\n0007,-25.50,"He said ""Hi""\nagain"\r\n';
  const result=captureImportDraft('payroll_individual',source,{rows:[{cells:[{field:'employee_id',cellId:'r2c1'},{field:'amount',cellId:'r2c2'},{field:'notes',cellId:'r2c3'}]}]},'','table');
  expect(result.rows[0]).toContain('0007');expect(result.rows[0]).toContain('-25.50');expect(result.rows[0]).toContain('He said "Hi"\nagain');
  expect(()=>captureImportDraft('payroll_individual',source,{rows:[{cells:[{field:'amount',cellId:'r20c1'}]}]},'','table')).toThrow();
 });
 it('rejects text slicing of a spreadsheet value and accepts only exact PDF/request quotes',()=>{
  expect(()=>captureImportDraft('payroll_history','100',{rows:[{cells:[{field:'amount',start:0,end:2}]}]},'','table')).toThrow();
  const result=captureImportDraft('payroll_history','Amount -25.50',{rows:[{cells:[{field:'amount',quote:'-25.50'}]}]});
  expect(result.rows[0]).toContain('-25.50');
  expect(()=>captureImportDraft('payroll_history','Amount -25.50',{rows:[{cells:[{field:'amount',quote:'999'}]}]})).toThrow();
 });
 it('accepts literal dates supplied by the user, without allowing invented replacements',()=>{
  const request='Start date 2026-10-01';
  const result=captureImportDraft('payroll_fixed','E001',{rows:[{cells:[{field:'employee_id',start:0,end:4},{field:'start_date',from:'instruction',start:11,end:21}]}]},request);
  expect(result.rows[0]).toContain('2026-10-01');
  expect(()=>captureImportDraft('payroll_fixed','E001',{rows:[{cells:[{field:'start_date',from:'instruction',start:11,end:99}]}]},request)).toThrow();
 });
 it('preserves signed amounts and leading zero identifiers in import CSV',()=>{
  const d=captureImportDraft('payroll_history','0007 -25.50',{rows:[{cells:[{field:'employee_no',start:0,end:4},{field:'amount',start:5,end:11}]}]});
  expect(parseCsvRecords(importDraftCsv(d)).records[0]).toMatchObject({employee_no:'0007',amount:'-25.50'});
 });
 it.each([
  {field:'amount',start:5,end:99}, {field:'amount',start:9,end:5}, {field:'commit',start:0,end:4},
  {field:'amount',start:5,end:11,value:'999'},
 ])('rejects fabricated values, unknown fields and invalid spans: %j',cell=>{
  expect(()=>captureImportDraft('payroll_history',source,{rows:[{cells:[cell]}]})).toThrow();
 });
 it('rejects repeated fields and duplicate source records',()=>{
  const cell={field:'amount',start:5,end:11};
  expect(()=>captureImportDraft('payroll_history',source,{rows:[{cells:[cell,cell]}]})).toThrow();
  expect(()=>captureImportDraft('payroll_history',source,{rows:[{cells:[cell]},{cells:[cell]}]})).toThrow();
 });
 it.each(IMPORT_TARGETS)('offers a closed canonical contract for %s',target=>{
  expect(()=>captureImportDraft(target,source,{rows:[{cells:[{field:'execute_import',start:0,end:4}]}]})).toThrow();
 });
});

describe('file preparation and review',()=>{
 it('keeps the request and attachment in one composer and sends only protected import preparation',async()=>{
  const ordinary=vi.fn();wrap(<WorkspaceComposer fileImport layout="hero" action={ordinary} tasks={[]} labels={{tasks:'Tasks',taskHint:'Choose a task',question:'Chat question',placeholder:'Ask',ask:'Send',working:'Working',scope:'Your access'}}/>);
  const question=screen.getByRole('textbox',{name:'Chat question'});fireEvent.change(question,{target:{value:'Prepare these records'}});
  await attach();expect(question).toHaveValue('Prepare these records');expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByRole('button',{name:'Send'})).toBeDisabled();expect(document.querySelectorAll('form')).toHaveLength(1);expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:'Send'}));
  await screen.findByText('Draft: 1 record');expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({instruction:'Prepare these records'}));expect(ordinary).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:copy.review})).toBeDisabled();
 });
 it('requires an explicit request and provider consent, then a separate source review',async()=>{
  wrap();await attach();const prepare=screen.getByRole('button',{name:copy.prepare});
  expect(prepare).toBeDisabled();
  fireEvent.change(screen.getByLabelText(copy.target),{target:{value:'payroll_history'}});
  fireEvent.change(screen.getByLabelText(copy.request),{target:{value:'Prepare these payroll records'}});
  expect(prepare).toBeDisabled();expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(prepare);
  await screen.findByText('Draft: 1 record');
  expect(mocks.prepare).toHaveBeenCalledWith({target:'payroll_history',source,sourceKind:'text',instruction:'Prepare these payroll records',consent:true});
  const next=screen.getByRole('button',{name:copy.review});expect(next).toBeDisabled();expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText(copy.reviewed));fireEvent.click(next);
  expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/payroll\/history-import\?assistantImport=[a-f0-9-]+$/));
  expect(mocks.push.mock.calls[0][0]).not.toContain('E001');
 });
 it('does not revive a discarded draft when an in-flight provider response arrives',async()=>{
  let finish!:(v:unknown)=>void;mocks.prepare.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  wrap();await attach();fireEvent.change(screen.getByLabelText(copy.request),{target:{value:'Prepare records'}});fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));
  fireEvent.click(screen.getByRole('button',{name:copy.discard}));finish({ok:true,draft});
  await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByText('Draft: 1 record')).toBeNull();expect(mocks.push).not.toHaveBeenCalled();
 });
 it('requires choosing one sheet, invalidates consent when the sheet changes and sends only that sheet',async()=>{
  mocks.read.mockResolvedValue({name:'records.pdf',parts:[{label:'Sheet A',text:'one'},{label:'Sheet B',text:'two'}]});
  wrap();await attach();fireEvent.change(screen.getByLabelText(copy.request),{target:{value:'Prepare'}});fireEvent.click(screen.getByLabelText(copy.consent));
  fireEvent.change(screen.getByLabelText(copy.sheet),{target:{value:'1'}});
  expect(screen.getByLabelText(copy.consent)).not.toBeChecked();
  fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));
  await waitFor(()=>expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({source:'two'})));
 });
 it('shows a failure and never offers confirmation on an invalid model response',async()=>{
  mocks.prepare.mockResolvedValue({ok:false});wrap();await attach();fireEvent.change(screen.getByLabelText(copy.request),{target:{value:'Prepare'}});fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));
  expect(await screen.findByRole('alert')).toHaveTextContent(copy.prepareError);expect(screen.queryByRole('button',{name:copy.review})).toBeNull();
 });
});

describe('inline attachment conversation lifecycle',()=>{
 const labels={tasks:'Tasks',taskHint:'Choose a task',question:'Chat question',placeholder:'Ask',ask:'Send',working:'Working',scope:'Your access'};
 function Chat({ordinary=vi.fn(),busy=vi.fn(),published}:{ordinary?:(data:FormData)=>Promise<void>;busy?:(value:boolean)=>void;published?:(value:AttachmentChatTurn|null)=>void}){
  const[turn,setTurn]=useState<AttachmentChatTurn|null>(null),publish=useCallback((value:AttachmentChatTurn|null)=>{setTurn(value);published?.(value);},[published]);
  return <><div role="log" aria-label="Conversation">{turn&&<><p>{turn.question}</p>{turn.answer}</>}</div><WorkspaceComposer fileImport clearAfterSubmit layout="hero" action={ordinary} tasks={[]} labels={labels} onAttachmentTurn={publish} onAttachmentBusy={busy}/></>;
 }
 it('publishes selected source, consent, draft and editable review in the same thread without a second instruction field',async()=>{
  const ordinary=vi.fn(),busy=vi.fn();wrap(<Chat ordinary={ordinary} busy={busy}/>);const question=screen.getByRole('textbox',{name:labels.question});fireEvent.change(question,{target:{value:'Prepare records'}});await attach();
  expect(screen.getAllByRole('log')).toHaveLength(1);expect(screen.getByRole('log')).toHaveTextContent(copy.target);expect(screen.getAllByRole('textbox')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText(copy.target),{target:{value:'payroll_history'}});fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:'Send'}));await screen.findByText('Draft: 1 record');
  expect(question).toHaveValue('');expect(screen.getByRole('log')).toHaveTextContent('Prepare records');expect(ordinary).not.toHaveBeenCalled();expect(busy).toHaveBeenCalledWith(true);expect(busy).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByLabelText(copy.reviewed));expect(screen.getByRole('button',{name:copy.review})).toBeEnabled();
  fireEvent.change(screen.getByLabelText(copy.editHint),{target:{value:importDraftCsv(draft)}});expect(screen.getByLabelText(copy.reviewed)).not.toBeChecked();expect(screen.getByRole('button',{name:copy.review})).toBeDisabled();
 });
 it('retains a truthful blocked or invalid preparation reply and never falls through to ordinary chat',async()=>{
  mocks.prepare.mockResolvedValue({ok:false});const ordinary=vi.fn();wrap(<Chat ordinary={ordinary}/>);fireEvent.change(screen.getByRole('textbox',{name:labels.question}),{target:{value:'Prepare records'}});await attach();fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:'Send'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(copy.prepareError);expect(ordinary).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:copy.review})).toBeNull();
 });
 it('does not republish source or a late response after the attachment composer unmounts',async()=>{
  let finish!:(value:unknown)=>void;mocks.prepare.mockReturnValue(new Promise(resolve=>{finish=resolve;}));const publish=vi.fn(),busy=vi.fn();const view=wrap(<Chat published={publish} busy={busy}/>);
  fireEvent.change(screen.getByRole('textbox',{name:labels.question}),{target:{value:'Prepare records'}});await attach();fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:'Send'}));expect(mocks.prepare).toHaveBeenCalledTimes(1);
  view.unmount();expect(publish).toHaveBeenLastCalledWith(null);expect(busy).toHaveBeenLastCalledWith(false);const calls=publish.mock.calls.length;
  await act(async()=>finish({ok:true,draft}));expect(publish).toHaveBeenCalledTimes(calls);expect(mocks.push).not.toHaveBeenCalled();
 });
 it('does not revive an expired draft when native preparation finishes after its source deadline',async()=>{
  vi.useFakeTimers();let finish!:(value:unknown)=>void;mocks.prepare.mockReturnValue(new Promise(resolve=>{finish=resolve;}));wrap(<Chat/>);
  await act(async()=>{fireEvent.change(screen.getByRole('textbox',{name:labels.question}),{target:{value:'Prepare records'}});fireEvent.change(screen.getByLabelText(copy.attach,{selector:'input'}),{target:{files:[new File(['data'],'records.pdf')]}});await Promise.resolve();});
  fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:'Send'}));expect(mocks.prepare).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(600001);});expect(screen.getByRole('log')).toBeEmptyDOMElement();
  await act(async()=>finish({ok:true,draft}));expect(screen.queryByText('Draft: 1 record')).toBeNull();expect(screen.queryByRole('button',{name:copy.review})).toBeNull();expect(screen.getByRole('alert')).toHaveTextContent(copy.expired);
 });
 it('expires attachment data and removes the ephemeral reply after ten minutes',async()=>{
  vi.useFakeTimers();wrap(<Chat/>);await act(async()=>{fireEvent.change(screen.getByLabelText(copy.attach,{selector:'input'}),{target:{files:[new File(['data'],'records.pdf')]}});await Promise.resolve();});
  expect(screen.getByRole('log')).toHaveTextContent(copy.target);await act(async()=>{await vi.advanceTimersByTimeAsync(600001);});
  expect(screen.getByRole('log')).toBeEmptyDOMElement();expect(screen.queryByText('records.pdf')).toBeNull();expect(screen.getByRole('alert')).toHaveTextContent(copy.expired);
 });
});

describe('ephemeral handoff',()=>{
 it('clears drafts when the authenticated provider is remounted for another principal',()=>{
  let carrier!:NonNullable<ReturnType<typeof useAssistantImportHandoff>>;
  function Probe(){carrier=useAssistantImportHandoff()!;return null;}
  const view=render(<AssistantImportHandoffProvider key="principal-a"><Probe/></AssistantImportHandoffProvider>);
  const id=carrier.put('employee','private CSV');
  view.rerender(<AssistantImportHandoffProvider key="principal-b"><Probe/></AssistantImportHandoffProvider>);
  expect(carrier.take('employee',id)).toBeNull();
 });
 it('refuses a wrong destination, consumes once, and expires without browser storage',()=>{
  let carrier!:NonNullable<ReturnType<typeof useAssistantImportHandoff>>;
  function Probe(){carrier=useAssistantImportHandoff()!;return null;}wrap(<Probe/>);
  const id=carrier.put('employee','private CSV');
  expect(carrier.take('leave_bf',id)).toBeNull();expect(carrier.take('employee','wrong')).toBeNull();
  expect(carrier.take('employee',id)).toBe('private CSV');expect(carrier.take('employee',id)).toBeNull();
  const expired=carrier.put('employee','private CSV');const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+600001);
  expect(carrier.take('employee',expired)).toBeNull();clock.mockRestore();
 });
 it('does not consume a draft without the matching URL nonce',async()=>{
  const receive=vi.fn();function Probe(){useAssistantImportIntake('employee',receive);return null;}
  wrap(<Probe/>);await waitFor(()=>expect(receive).not.toHaveBeenCalled());
 });
});
