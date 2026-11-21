// @vitest-environment jsdom
/** Board 60f1fdcd: the Change log page lists who changed what, when and why, filters by area and exports the same
 * filters; a reader without Rewards configuration access sees only the refusal. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {resolveServerTree} from './helpers/server-tree';
const copies={en,ms,zh,ta,th,vi:viCopy};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',denied:false,filters:[] as unknown[]}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>createTranslator({locale:state.locale,messages:copies[state.locale],namespace:namespace as 'rewardConfig'})}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'fictional-tenant',userId:'fictional-editor'})}));
vi.mock('../packs/rewards/config-change',async()=>({
 rewardConfigAreas:(await import('../packs/rewards/config-change-model')).rewardConfigAreas,
 rewardConfigLogCompanies:async()=>[{id:'11111111-1111-4111-8111-000000000001',name:'Fictional Construction Sdn Bhd'}],
 rewardConfigChangeLog:async(_ctx:unknown,filter:unknown)=>{state.filters.push(filter);if(state.denied)throw new Error('The Rewards change log is not available to you.');return{page:1,hasMore:true,rows:[
  {id:'c1',area:'bonus',action:'activated',itemId:'l1',itemLabel:'Group Standard 2026',companyIds:[],companyNames:[],versionRef:'3',actorKind:'user',actorName:'Fictional Mei Ong',at:'2026-11-12T02:30:00.000Z',reason:'Annual matrix refresh agreed with finance',highImpact:true,changedCount:3,
   summary:{area:'bonus',itemLabel:'Group Standard 2026',changedCount:3,affected:[],highImpact:['released-library'],lines:[{key:'12:ME',label:'JG 12 ME',before:'2.00',after:'2.25'}]}},
  {id:'c2',area:'pat',action:'returned-to-draft',itemId:'p1',itemLabel:'PAT 2026',companyIds:['11111111-1111-4111-8111-000000000001'],companyNames:['Fictional Construction Sdn Bhd'],versionRef:'1',actorKind:'system',actorName:null,at:'2026-11-12T01:00:00.000Z',reason:'Returned to Draft: the second-person confirmation was retired (board 60f1fdcd).',highImpact:false,changedCount:0,summary:{previousState:'pending'}},
 ]};},
}));
import Page from '../app/admin/rewards/change-log/page';
afterEach(()=>{cleanup();state.denied=false;state.filters=[];state.locale='en';});
async function show(params:Record<string,string>={}){const tree=await resolveServerTree(await Page({searchParams:Promise.resolve(params)}));return render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale]} onError={error=>{throw error;}}>{tree}</NextIntlClientProvider>);}

describe('Rewards change log page',()=>{
 it('lists each change with its person, area, item, values and reason',async()=>{
  await show({area:'bonus',high:'1',page:'1'});
  expect(state.filters[0]).toEqual({area:'bonus',companyId:undefined,actor:undefined,from:undefined,to:undefined,highImpact:true,page:1});
  const rows=[screen.getByText('Fictional Mei Ong').closest('tr')!,screen.getByText('System').closest('tr')!];
  expect(within(rows[0]).getByText('Fictional Mei Ong')).toBeTruthy();
  expect(within(rows[0]).getByText('Bonus matrices')).toBeTruthy();expect(within(rows[0]).getByText('High impact')).toBeTruthy();
  expect(within(rows[0]).getByText('Made active · v3')).toBeTruthy();
  expect(within(rows[0]).getByText('JG 12 ME')).toBeTruthy();expect(within(rows[0]).getByText('2.25')).toBeTruthy();
  expect(within(rows[0]).getByText('Annual matrix refresh agreed with finance')).toBeTruthy();
  expect(within(rows[1]).getByText('System')).toBeTruthy();expect(within(rows[1]).getByText('Fictional Construction Sdn Bhd')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Export to Excel'})).toHaveAttribute('href','/admin/rewards/change-log/export?area=bonus&high=1');
  expect(screen.getByRole('link',{name:'Next'})).toHaveAttribute('href','?area=bonus&high=1&page=2');
 });
 it('ignores malformed filters instead of trusting them',async()=>{
  await show({area:'payroll',company:'not-a-uuid',from:'12/11/2026',page:'-4'});
  expect(state.filters[0]).toEqual({area:undefined,companyId:undefined,actor:undefined,from:undefined,to:undefined,highImpact:undefined,page:1});
 });
 it('shows the refusal to a reader without Rewards configuration access',async()=>{
  state.denied=true;await show();
  expect(screen.getByText(en.rewardConfig.noAccess)).toBeTruthy();expect(screen.queryByRole('table')).toBeNull();
 });
 it.each(Object.keys(copies) as (keyof typeof copies)[])('renders in %s',async locale=>{
  state.locale=locale;await show();
  expect(screen.getByRole('link',{name:copies[locale].rewardConfig.exportExcel})).toBeTruthy();
  // Once as a filter choice and once on the PAT row.
  expect(screen.getAllByText(copies[locale].rewardConfig.areas.pat)).toHaveLength(2);
 });
});
