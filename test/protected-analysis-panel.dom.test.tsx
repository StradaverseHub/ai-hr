import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
const h=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../app/(app)/analytics/ai-actions',()=>({readProtectedAnalysisAction:h.action}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-10-30'}));
import {ProtectedAnalysisPanel,type ProtectedAnalysisLabels} from '../components/assistant/protected-analysis-panel';
const labels:ProtectedAnalysisLabels={title:'Explain company overview',description:'Explain authorized source facts.',companyScope:'Selected companies only. Department and search filters do not apply.',domain:'Area',month:'Completed month',compareWindow:'Compare completed months.',snapshotWindow:'Current source snapshot; no historical trend.',run:'Explain overview',thinking:'Thinking…',result:'Explanation',
 domains:{workforce:'Workforce',attendance:'Attendance',leave:'Leave',payroll:'Payroll',claims:'Claims',performance:'Performance',rewards:'Rewards',organisation:'Organisation'},
 notices:{invalid_request:'Choose an available source.',privacy_unavailable:'This source is waiting for its privacy review.',unavailable:'The current scope or privacy support is unavailable.',temporarily_unavailable:'Try again later.',failed:'The explanation could not be prepared.'}};
const scopeKey='["selected-company"]';
function deferred(){let resolve!:(value:unknown)=>void;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
beforeEach(()=>vi.clearAllMocks());afterEach(cleanup);
describe('explicit protected source explanation panel',()=>{
 it('waits for an explicit click, defaults to the last completed HR month and shows a shared waiting state',async()=>{
  const request=deferred();h.action.mockReturnValue(request.promise);render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  expect(h.action).not.toHaveBeenCalled();expect((screen.getByLabelText('Completed month') as HTMLInputElement).value).toBe('2026-09');
  expect(screen.getByText(labels.companyScope)).toBeTruthy();
  act(()=>{fireEvent.click(screen.getByRole('button',{name:labels.run}));fireEvent.click(screen.getByRole('button',{name:labels.run}));});
  expect(h.action).toHaveBeenCalledExactlyOnceWith({domain:'workforce',month:'2026-09'});expect(screen.getByRole('status').textContent).toBe('Thinking…');
  await act(async()=>{request.resolve({ok:true,text:'The native workforce total increased.',scopeKey});await request.promise;});
  expect(screen.getByLabelText(labels.result).textContent).toBe('The native workforce total increased.');
 });
 it('renders returned text literally, without executing HTML or treating it as a link',async()=>{
  h.action.mockResolvedValue({ok:true,text:'<img src=x onerror=alert(1)> [open](https://example.test)',scopeKey});render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  fireEvent.click(screen.getByRole('button',{name:labels.run}));await screen.findByLabelText(labels.result);
  expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByRole('link')).toBeNull();expect(screen.getByLabelText(labels.result).textContent).toContain('<img');
 });
 it('uses current snapshots for non-monthly domains and clears prior results when selection changes',async()=>{
  h.action.mockResolvedValue({ok:true,text:'Previous workforce result',scopeKey});render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  fireEvent.click(screen.getByRole('button',{name:labels.run}));await screen.findByLabelText(labels.result);
  fireEvent.change(screen.getByLabelText('Area'),{target:{value:'claims'}});
  expect(screen.queryByLabelText(labels.result)).toBeNull();expect(screen.queryByLabelText('Completed month')).toBeNull();expect(screen.getByText(labels.snapshotWindow)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:labels.run}));await waitFor(()=>expect(h.action).toHaveBeenLastCalledWith({domain:'claims'}));
 });
 it('discards old in-flight results after the selected company context changes',async()=>{
  const request=deferred();h.action.mockReturnValue(request.promise);const view=render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  fireEvent.click(screen.getByRole('button',{name:labels.run}));view.rerender(<ProtectedAnalysisPanel labels={labels} scopeKey='["different-company"]'/>);
  await act(async()=>{request.resolve({ok:true,text:'STALE_RESULT',scopeKey});await request.promise;});expect(screen.queryByText('STALE_RESULT')).toBeNull();
 });
 it('refuses a server-result company scope mismatch',async()=>{
  h.action.mockResolvedValue({ok:true,text:'WRONG_SCOPE_RESULT',scopeKey:'[]'});render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  fireEvent.click(screen.getByRole('button',{name:labels.run}));await screen.findByText(labels.notices.unavailable);expect(screen.queryByText('WRONG_SCOPE_RESULT')).toBeNull();
 });
 it('shows safe translated privacy/small-support notices and suppresses thrown diagnostics',async()=>{
  h.action.mockResolvedValueOnce({ok:false,notice:'privacy_unavailable'}).mockResolvedValueOnce({ok:false,notice:'unavailable'}).mockRejectedValueOnce(Error('PRIVATE SQL TOKEN DIAGNOSTIC'));
  render(<ProtectedAnalysisPanel labels={labels} scopeKey={scopeKey}/>);
  for(const notice of ['privacy_unavailable','unavailable','failed'] as const){fireEvent.click(screen.getByRole('button',{name:labels.run}));await screen.findByText(labels.notices[notice]);}
  expect(document.body.textContent).not.toContain('PRIVATE SQL TOKEN');
 });
});
