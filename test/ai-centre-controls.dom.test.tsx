import {render,screen} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import en from '../messages/ai-centre/en.json';

const owners=vi.hoisted(()=>({state:vi.fn(),reads:vi.fn(),withTenant:vi.fn(),keys:vi.fn()}));
vi.mock('next/link',()=>({default:({children,...props}:{children:unknown})=>createElement('a',props,children as never)}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>Object.assign((key:string,values?:Record<string,unknown>)=>{
 let text=(en.aiCentre.controls as Record<string,string>)[key]??key;
 for(const [name,value] of Object.entries(values??{}))text=text.replaceAll('{'+name+'}',String(value));
 return text;
},{has:()=>false})}));
vi.mock('../components/ui',()=>({Card:({children,...props}:{children:unknown})=>createElement('section',props,children as never),SectionHeader:({title}:{title:string})=>createElement('h2',null,title),btnGhost:'ghost',btnPrimary:'primary'}));
vi.mock('../db/client',()=>({withTenant:owners.withTenant}));
vi.mock('../core/ai-centre-control',()=>({aiCentreControlState:owners.state}));
vi.mock('../core/ai-centre-inventory',()=>({aiCentreReadControls:owners.reads,aiCentreJobTypes:()=>[],aiCentreFunctions:()=>[
 {key:'read:explain_pay_difference',name:'Pay difference explanation',control:'read',href:'#'},
 {key:'system:validation',name:'Required HR validation',control:'required',href:'#'},
]}));
vi.mock('../core/mandates/mandates',()=>({readMandateKeysTx:owners.keys}));
vi.mock('../app/control-tower/agents/centre-control-actions',()=>({setAiCentreFunctionAction:vi.fn(),setAiCentreJobAction:vi.fn(),setAiCentreStopAction:vi.fn()}));
import {AiCentreControls} from '../app/control-tower/agents/centre-controls';

beforeEach(()=>{
 owners.state.mockResolvedValue({stopped:false,generation:0,pending:2});owners.reads.mockResolvedValue(new Map([['read:explain_pay_difference',false]]));
 owners.withTenant.mockResolvedValue([]);
});
describe('AI centre control status',()=>{
 it('renders separate function controls and the boundary for already-sent requests',async()=>{
  render(await AiCentreControls({session:{tenantId:'fixture'}}));
  expect(screen.getByRole('button',{name:'Stop all AI activity'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Turn on · Pay difference explanation',hidden:true})).toBeInTheDocument();
  expect(screen.getByText(/Unsettled provider requests: 2/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Required HR validation/})).not.toBeInTheDocument();
 });
 it('does not display a missing function registration as enabled',async()=>{
  owners.reads.mockResolvedValue(new Map());
  render(await AiCentreControls({session:{tenantId:'fixture'}}));
  expect(screen.getByText(/Control status could not be confirmed/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Turn (on|off)/,hidden:true})).not.toBeInTheDocument();
 });
 it('offers resume only after a confirmed stopped state',async()=>{
  owners.state.mockResolvedValue({stopped:true,generation:3,pending:0});
  render(await AiCentreControls({session:{tenantId:'fixture'}}));
  expect(screen.getByRole('button',{name:'Resume eligible AI activity'})).toBeInTheDocument();
  expect(screen.getByText('AI activity is stopped.')).toBeInTheDocument();
 });
 it('never presents an unreadable control as running or offers a stale resume',async()=>{
  owners.state.mockRejectedValue(Error('unavailable'));owners.reads.mockRejectedValue(Error('unavailable'));
  render(await AiCentreControls({session:{tenantId:'fixture'}}));
  expect(screen.getAllByText(/Control status could not be confirmed/).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button',{name:/Resume eligible/})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Turn on/})).not.toBeInTheDocument();
 });
});
