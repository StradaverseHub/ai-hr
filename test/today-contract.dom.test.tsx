import {beforeEach,describe,expect,it,vi} from 'vitest';
import {resolveServerTree} from './helpers/server-tree';
import {TodayContracts} from '../components/today/contract-slot';
import {render,screen,within} from '@testing-library/react';
import {ContractSection} from '../components/today/contract-section';
const native=vi.hoisted(()=>({read:vi.fn(),enabled:true}));
vi.mock('@/packs/contracts/service',()=>({contractSharedWorkPage:native.read}));
vi.mock('@/lib/authz',()=>({isModuleEnabledOrFalse:()=>native.enabled}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');const messages=(await import('../messages/en.json')).default;return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never})};});
const labels={title:'Contract signatures',signLabel:'Sign letter',allLabel:'View all 127',countLabel:'127 letters are waiting for your signature'};
describe('Today Contract signatures',()=>{
 it('shows the exact owner total with a bounded preview and the complete owner queue link',()=>{
  const items=Array.from({length:5},(_,index)=>({id:`letter-${index}`,subjectName:`Fictional person ${index+1}`,linkPath:`/lifecycle/contract-staff?letter=letter-${index}`}));
  const view=render(<ContractSection {...labels} total={127} items={items}/>);
  const section=screen.getByRole('region',{name:'Contract signatures'});expect(section).toHaveAttribute('data-contract-total','127');
  expect(within(section).getByText('127 letters are waiting for your signature')).toBeInTheDocument();expect(view.container.querySelectorAll('[data-contract-home-item]')).toHaveLength(5);
  expect(within(section).getByRole('link',{name:'View all 127'})).toHaveAttribute('href','/tasks?contractPage=1');
  expect(within(section).getByRole('link',{name:'Fictional person 1 Sign letter'})).toHaveAttribute('href',items[0].linkPath);
 });
 it('draws no work card when the owner reports zero signatures',()=>{
  const view=render(<ContractSection {...labels} total={0} items={[]}/>);expect(view.container).toBeEmptyDOMElement();
 });
});

const session={tenantId:'fictional-tenant',userId:'fictional-account',personId:'fictional-person',roles:['employee'],entitlements:{enabledModules:['lifecycle'],scopedModules:{}}} as never;
beforeEach(()=>{native.enabled=true;native.read.mockReset();});
describe('Today Contract native owner slot',()=>{
 it('reads exactly one bounded task page and uses the independent total',async()=>{
  native.read.mockResolvedValue({items:[{id:'letter-a',subjectName:'Fictional employee',linkPath:'/lifecycle/contract-staff?letter=letter-a',action:'sign'}],total:127,taskTotal:127});
  render(await resolveServerTree(TodayContracts({session})));
  expect(native.read).toHaveBeenCalledExactlyOnceWith(session,{category:'tasks',limit:5,offset:0});
  expect(screen.getByRole('link',{name:'View all 127'})).toBeInTheDocument();
 });
 it('does not read Contract work when Lifecycle is unavailable',()=>{
  native.enabled=false;expect(TodayContracts({session})).toBeNull();expect(native.read).not.toHaveBeenCalled();
 });
 it('shows a retry path when the owner fails instead of reporting no signatures',async()=>{
  native.read.mockRejectedValue(new Error('Fictional owner unavailable'));render(await resolveServerTree(TodayContracts({session})));
  expect(screen.getByText(/Contract signatures could not be loaded/)).toBeInTheDocument();expect(screen.getByRole('link',{name:'Open Tasks'})).toHaveAttribute('href','/tasks?contractPage=1');
  expect(screen.queryByRole('region',{name:'Contract signatures'})).not.toBeInTheDocument();
 });
});
