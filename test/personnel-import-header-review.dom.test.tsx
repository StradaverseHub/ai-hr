/** Authored UNRUN. Real local UI + packet builder; server actions mocked. This does not establish
 * provider, session, durable-attempt, browser, canonical import or production security proof. */
import * as React from 'react';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PersonnelImportHeaderReview} from '../components/personnel-import-header-review';
import {capturePersonnelImportSource} from '../lib/personnel-import-assistance-source';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({prepare:vi.fn(),execute:vi.fn(),reopen:vi.fn()}));
vi.mock('../app/(app)/admin/personnel/import/assistance-actions',()=>({preparePersonnelImportHeadersAction:state.prepare,assistPersonnelImportHeadersAction:state.execute,reopenPersonnelImportHeadersAction:state.reopen}));
const messages=en.people.import.headerAssistance,companyId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222';
const source=(revision='local-1',heading='Who is this?')=>capturePersonnelImportSource({text:`${heading},email\r\nPRIVATE PERSON,private@fixture.test\r\n`,fileName:'PRIVATE original.csv',format:'csv'},revision);
const result=(command:any)=>({kind:'proposal',attemptId,attemptVersion:1,proposal:{version:1,sourceRevision:command.request.sourceRevision,registryDigest:command.request.registryDigest,mappings:command.request.headers.map((header:any)=>({columnIndex:header.columnIndex,status:'mapped',field:'full_name'}))}});
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('crypto',webcrypto);state.prepare.mockImplementation(async packet=>({kind:'prepared',attemptId,attemptVersion:1,sourceRevision:packet.sourceRevision,registryDigest:packet.registryDigest}));state.execute.mockImplementation(async command=>result(command));state.reopen.mockImplementation(async command=>result(command));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(current=source(),onApply=vi.fn()){
 const props={source:current,companyId,options:{columns:['full_name','email']},choices:[{key:'full_name',label:'Full name'},{key:'email',label:'Email'}],messages,onApply,onCancel:vi.fn()};
 const view=render(<PersonnelImportHeaderReview {...props}/>);view.container.querySelector('details')!.open=true;return{...view,props,onApply};
}
function consent(){fireEvent.click(screen.getByRole('checkbox',{name:'1: Who is this?'}));fireEvent.click(screen.getByRole('checkbox',{name:messages.aiConsent}));}
describe('reviewed header-only AI assistance',()=>{
 it('does nothing without explicit reviewed-heading consent and keeps manual mapping usable',()=>{
  const view=mount();expect(screen.getByRole('button',{name:messages.aiSend})).toBeDisabled();expect(state.prepare).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox',{name:'Import field: Who is this?'}),{target:{value:'full_name'}});
  fireEvent.click(screen.getByRole('button',{name:messages.applyMapping}));expect(view.onApply).toHaveBeenCalledWith(['full_name','email'],'local-1',undefined);expect(state.execute).not.toHaveBeenCalled();
 });
 it('sends only exact selected headings, uses the issued attempt binding, and requires explicit adoption then local apply',async()=>{
  const view=mount();consent();fireEvent.click(screen.getByRole('button',{name:messages.aiSend}));
  await waitFor(()=>expect(state.execute).toHaveBeenCalledOnce());await screen.findByText(messages.aiReady);
  const packet=state.prepare.mock.calls[0][0];expect(packet.headers).toEqual([{columnIndex:0,heading:'Who is this?'}]);
  expect(Object.keys(packet).sort()).toEqual(['companyId','consent','headers','mode','operationNonce','registryDigest','sourceRevision','version']);expect(JSON.stringify(packet)).not.toMatch(/PRIVATE|private@|original\.csv/);
  expect(state.execute.mock.calls[0][0]).toEqual({attemptId,attemptVersion:1,request:packet});
  expect(screen.getByRole('combobox',{name:'Import field: Who is this?'})).toHaveValue('');expect(view.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:`${messages.aiUseSuggestion}: Full name`}));expect(view.onApply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:messages.applyMapping}));expect(view.onApply).toHaveBeenCalledWith(['full_name','email'],'local-1',{attemptId,attemptVersion:1,adoptedMappings:1});
 });
 it('removes AI-use attribution when the human manually overrides an adopted choice',async()=>{
  const view=mount();consent();fireEvent.click(screen.getByRole('button',{name:messages.aiSend}));await screen.findByText(messages.aiReady);fireEvent.click(screen.getByRole('button',{name:`${messages.aiUseSuggestion}: Full name`}));
  const field=screen.getByRole('combobox',{name:'Import field: Who is this?'});fireEvent.change(field,{target:{value:''}});fireEvent.change(field,{target:{value:'full_name'}});fireEvent.click(screen.getByRole('button',{name:messages.applyMapping}));expect(view.onApply).toHaveBeenCalledWith(['full_name','email'],'local-1',undefined);
 });
 it('reopens an uncertain execute using the exact saved server identity without preparing or executing again',async()=>{
  state.execute.mockRejectedValue(Error('PRIVATE RAW provider diagnostics'));mount();consent();fireEvent.click(screen.getByRole('button',{name:messages.aiSend}));await screen.findByText(messages.aiUncertain);
  expect(screen.queryByText('PRIVATE RAW provider diagnostics')).toBeNull();fireEvent.click(screen.getByRole('button',{name:messages.aiReopen}));await waitFor(()=>expect(state.reopen).toHaveBeenCalledOnce());
  expect(state.prepare).toHaveBeenCalledOnce();expect(state.execute).toHaveBeenCalledOnce();expect(state.reopen.mock.calls[0][0]).toEqual(state.execute.mock.calls[0][0]);
  fireEvent.click(screen.getByRole('button',{name:messages.aiNewRequest}));expect(screen.getByRole('checkbox',{name:messages.aiConsent})).not.toBeChecked();expect(screen.getByRole('button',{name:messages.aiSend})).toBeDisabled();
 });
 it('does not execute, reopen or automatically recreate an uncertain preparation with no issued identity',async()=>{
  state.prepare.mockRejectedValue(Error('uncertain fictional preparation'));mount();consent();fireEvent.click(screen.getByRole('button',{name:messages.aiSend}));await screen.findByText(messages.aiPrepareUnknown);
  expect(state.prepare).toHaveBeenCalledOnce();expect(state.execute).not.toHaveBeenCalled();expect(state.reopen).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:messages.aiReopen})).toBeNull();
 });
 it('refuses execute after the complete local matrix revision changes while preparation is pending',async()=>{
  let resolve!:(value:unknown)=>void;state.prepare.mockImplementation(()=>new Promise(yes=>{resolve=yes;}));const view=mount();consent();fireEvent.click(screen.getByRole('button',{name:messages.aiSend}));await waitFor(()=>expect(state.prepare).toHaveBeenCalledOnce());const packet=state.prepare.mock.calls[0][0];
  view.rerender(<PersonnelImportHeaderReview {...view.props} source={source('local-2')}/>);
  resolve({kind:'prepared',attemptId,attemptVersion:1,sourceRevision:packet.sourceRevision,registryDigest:packet.registryDigest});await waitFor(()=>expect(screen.getByRole('button',{name:messages.aiSend})).not.toHaveTextContent(messages.aiWorking));expect(state.execute).not.toHaveBeenCalled();expect(view.onApply).not.toHaveBeenCalled();
 });
 it('refuses overlong headings without shortening or dispatching them',()=>{
  mount(source('local-long','X'.repeat(97)));fireEvent.click(screen.getByRole('checkbox',{name:`1: ${'X'.repeat(97)}`}));expect(screen.getByRole('checkbox',{name:messages.aiConsent})).toBeDisabled();expect(screen.getByRole('button',{name:messages.aiSend})).toBeDisabled();expect(state.prepare).not.toHaveBeenCalled();
 });
});
