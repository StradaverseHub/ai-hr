import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveServerTree} from './helpers/server-tree';
import {TodayContracts} from '../components/today/contract-slot';
import {render,screen,within} from '@testing-library/react';
import {ContractSection} from '../components/today/contract-section';
import {readTodayContractWork} from '../components/today/contract-read';
import {NextStepPanel,type PanelContext} from '../components/today/employee/panels';
const native=vi.hoisted(()=>({read:vi.fn(),enabled:true,entitlementError:null as Error|null}));
vi.mock('@/packs/contracts/service',()=>({contractSharedWorkPage:native.read}));
vi.mock('@/core/entitlements',()=>({isModuleEnabled:()=>{if(native.entitlementError)throw native.entitlementError;return native.enabled;}}));
vi.mock('@/components/today/employee/reads',()=>({
 readOwnReadiness:async()=>({failed:false,period:{cutOff:null},items:[]}),
 readOwnPassportCards:async()=>[],
}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator}=await import('next-intl');const base=(await import('../messages/en.json')).default;
 const {withAiCentre}=await import('./helpers/ai-centre-messages');const messages=withAiCentre('en',base);
 return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never})};
});
const labels={title:'Contract signatures',signLabel:'Sign letter',allLabel:'View all 127',countLabel:'127 letters are waiting for your signature'};
describe('Today Contract signatures',()=>{
 it('shows the exact owner total with a bounded preview and the complete owner queue link',()=>{
  const items=Array.from({length:5},(_,index)=>({id:`letter-${index}`,subjectName:`Fictional person ${index+1}`,linkPath:`/lifecycle/contract-staff?letter=letter-${index}`}));
  const view=render(<ContractSection {...labels} total={127} items={items}/>);
  const section=screen.getByRole('region',{name:'Contract signatures'});expect(section).toHaveAttribute('data-contract-total','127');
  expect(within(section).getByText('127 letters are waiting for your signature')).toBeInTheDocument();expect(view.container.querySelectorAll('[data-contract-home-item]')).toHaveLength(5);
  expect(within(section).getByRole('link',{name:'View all 127'})).toHaveAttribute('href','/tasks');
  expect(within(section).getByRole('link',{name:'Fictional person 1 Sign letter'})).toHaveAttribute('href',items[0].linkPath);
 });
 it('draws no work card when the owner reports zero signatures',()=>{
  const view=render(<ContractSection {...labels} total={0} items={[]}/>);expect(view.container).toBeEmptyDOMElement();
 });
});

const session={tenantId:'fictional-tenant',userId:'fictional-account',personId:'fictional-person',roles:['employee'],entitlements:{enabledModules:['lifecycle'],scopedModules:{}}} as never;
beforeEach(()=>{native.enabled=true;native.entitlementError=null;native.read.mockReset();});
describe('Today Contract native owner slot',()=>{
 it('reads exactly one bounded task page and uses the independent total',async()=>{
  native.read.mockResolvedValue({items:[{id:'letter-a',subjectName:'Fictional employee',linkPath:'/lifecycle/contract-staff?letter=letter-a',action:'sign'}],total:127,taskTotal:127});
  render(await resolveServerTree(TodayContracts({session})));
  expect(native.read).toHaveBeenCalledExactlyOnceWith(session,{category:'tasks',limit:5,offset:0});
  expect(screen.getByRole('link',{name:'View all 127'})).toBeInTheDocument();
 });
 it('does not read Contract work when Lifecycle is disabled',async()=>{
  native.enabled=false;expect(TodayContracts({session})).toBeNull();expect(native.read).not.toHaveBeenCalled();
  await expect(readTodayContractWork(session)).resolves.toEqual({status:'disabled'});expect(native.read).not.toHaveBeenCalled();
 });
 it('reads the native page for a company-scoped Lifecycle entitlement',async()=>{
  native.enabled=false;const scopedSession={tenantId:'fictional-tenant',userId:'fictional-account',personId:'fictional-person',roles:['employee'],entitlements:{enabledModules:[],scopedModules:{lifecycle:['fictional-company']}}} as never;
  native.read.mockResolvedValue({items:[],taskTotal:0});
  await expect(readTodayContractWork(scopedSession)).resolves.toEqual({status:'ready',page:{items:[],taskTotal:0}});
  expect(native.read).toHaveBeenCalledExactlyOnceWith(scopedSession,{category:'tasks',limit:5,offset:0});
 });
 it('shares one native promise across its card and the all-clear gate',async()=>{
  native.read.mockResolvedValue({items:[],taskTotal:0});const work=readTodayContractWork(session);
  const props:PanelContext={session,employmentId:'fictional-employment',locale:'en',today:'2026-11-18',modules:{payroll:'off',leave:'off',attendance:'off',claims:'off'},contractWork:work};
  const view=render(await resolveServerTree(<>{TodayContracts({session,work})}{await NextStepPanel(props)}</>));
  expect(native.read).toHaveBeenCalledExactlyOnceWith(session,{category:'tasks',limit:5,offset:0});
  expect(view.container.querySelector('[data-today-all-clear]')).not.toBeNull();
  expect(screen.getByRole('heading',{name:"You're all set"})).toBeInTheDocument();
  expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
 });
 it('keeps an entitlement failure unavailable without querying work or claiming all-clear',async()=>{
  native.entitlementError=new Error('Fictional entitlement resolution failed');const work=readTodayContractWork(session);
  await expect(work).resolves.toEqual({status:'unavailable'});
  const props:PanelContext={session,employmentId:'fictional-employment',locale:'en',today:'2026-11-18',modules:{payroll:'off',leave:'off',attendance:'off',claims:'off'},contractWork:work};
  const view=render(await resolveServerTree(<>{TodayContracts({session,work})}{await NextStepPanel(props)}</>));
  expect(native.read).not.toHaveBeenCalled();
  expect(screen.getByText(/Contract letters could not be loaded/)).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'Open Tasks'})).toHaveAttribute('href','/tasks');
  expect(view.container.querySelector('[data-today-all-clear]')).toBeNull();
  expect(screen.queryByRole('region',{name:'Contract signatures'})).not.toBeInTheDocument();
 });
 it('shows a retry path when the owner fails instead of reporting no signatures',async()=>{
  native.read.mockRejectedValue(new Error('Fictional owner unavailable'));const work=readTodayContractWork(session);
  await expect(work).resolves.toEqual({status:'unavailable'});
  const props:PanelContext={session,employmentId:'fictional-employment',locale:'en',today:'2026-11-18',modules:{payroll:'off',leave:'off',attendance:'off',claims:'off'},contractWork:work};
  const view=render(await resolveServerTree(<>{TodayContracts({session,work})}{await NextStepPanel(props)}</>));
  expect(native.read).toHaveBeenCalledExactlyOnceWith(session,{category:'tasks',limit:5,offset:0});
  expect(screen.getByText(/Contract letters could not be loaded/)).toBeInTheDocument();expect(screen.getByRole('link',{name:'Open Tasks'})).toHaveAttribute('href','/tasks');
  expect(view.container.querySelector('[data-today-all-clear]')).toBeNull();
  expect(screen.queryByRole('region',{name:'Contract signatures'})).not.toBeInTheDocument();
 });
});

it('describes a mixed native task page without calling account confirmation a signature',async()=>{
 native.read.mockResolvedValue({items:[{id:'bound',subjectName:'Fictional linked employee',linkPath:'/lifecycle/contracts/letters/bound',action:'sign'},{id:'unbound',subjectName:'Fictional new account',linkPath:'/lifecycle/contracts/letters/unbound',action:'bindEmployee'}],total:127,taskTotal:127});
 render(await resolveServerTree(TodayContracts({session})));
 const section=screen.getByRole('region',{name:'Contract letters'});
 expect(within(section).getByText('127 contract letters need you')).toBeInTheDocument();
 expect(within(section).getByRole('link',{name:'Fictional new account Continue to signing'})).toHaveAttribute('href','/lifecycle/contracts/letters/unbound');
 expect(within(section).getByRole('link',{name:'Fictional linked employee Sign letter'})).toBeInTheDocument();
});
