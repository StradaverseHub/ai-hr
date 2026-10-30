import {afterEach,describe,it,expect,vi} from 'vitest';
import type {AnchorHTMLAttributes} from 'react';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {OffboardingStepPanel} from '../components/assistant/offboarding-step-panel';
import {OffboardingStepCompletion as C} from '../lib/assistant-actions/offboarding-step-completion-contract';
vi.mock('next-intl',()=>({useTranslations:()=> (key:string)=>key}));
vi.mock('next/link',()=>({default:({children,...props}:AnchorHTMLAttributes<HTMLAnchorElement>)=><a {...props}>{children}</a>}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const caseId='00000000-0000-4000-8000-000000000001',actionId='00000000-0000-4000-8000-000000000002';
const human={caseId,caseNumber:'OFB-0001',stepKey:'resign_submit',reference:null,notes:null,confirmStepCompletion:true,acceptDerivedCaseCompletion:false};
const prepared={action:C.action,contractVersion:1,actionId,reviewedDigest:'a'.repeat(64),createdAt:'2026-10-30T00:00:00.000Z',expiresAt:'2099-10-30T00:10:00.000Z',content:human,review:{caseId,caseNumber:'OFB-0001',companyId:caseId,stepKey:'resign_submit',stepLabel:'Submit resignation',resignationDate:'2026-10-01',lastWorkingDay:'2026-10-31',before:{done:false,caseStatus:'in_progress'},after:{done:true,caseStatus:'in_progress'},reference:null,notes:null}};
describe('offboarding step human confirmation',()=>{
 it('renders without a network request or native effect',()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);render(<OffboardingStepPanel/>);expect(fetch).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'load'})).toBeDisabled();});
 it('requires native choice, step attestation and a separate reviewed confirmation',async()=>{
  const packets:unknown[]=[];const fetch=vi.fn(async(_url:unknown,options:RequestInit)=>{const packet=JSON.parse(String(options.body));packets.push(packet);return Response.json(packet.operation==='choices'?{kind:'choices',cases:[{caseId,caseNumber:'OFB-0001',steps:[{key:'resign_submit',label:'Submit resignation'}]}],truncated:false}:packet.operation==='prepare'?{kind:'prepared',review:prepared}:{kind:'retired',receipt:{action:C.action,contractVersion:1,actionId,state:'discarded'}});});vi.stubGlobal('fetch',fetch);render(<OffboardingStepPanel/>);
  fireEvent.change(screen.getByLabelText('caseNumber'),{target:{value:'OFB-0001'}});fireEvent.click(screen.getByRole('button',{name:'load'}));await screen.findByRole('option',{name:'Submit resignation'});fireEvent.change(screen.getByLabelText('step'),{target:{value:'resign_submit'}});
  expect(screen.getByRole('button',{name:'prepare'})).toBeDisabled();fireEvent.click(screen.getByLabelText('stepConsent'));fireEvent.click(screen.getByRole('button',{name:'prepare'}));await screen.findByText('OFB-0001 · Submit resignation');
  expect(screen.getByRole('button',{name:'confirm'})).toBeDisabled();expect(packets).toHaveLength(2);fireEvent.click(screen.getByLabelText('confirmConsent'));expect(screen.getByRole('button',{name:'confirm'})).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'discard'}));await screen.findByText('retired');expect(packets.map(p=>(p as {operation:string}).operation)).toEqual(['choices','prepare','discard']);
 });
 it('keeps response uncertainty on the same review id and never automatically confirms',async()=>{
  const fetch=vi.fn().mockRejectedValue(Error('lost response'));vi.stubGlobal('fetch',fetch);render(<OffboardingStepPanel resumeActionId={actionId}/>);expect(fetch).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'reopen'}));await screen.findByRole('alert');await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({action:C.action,operation:'reopen',actionId});
 });
});
