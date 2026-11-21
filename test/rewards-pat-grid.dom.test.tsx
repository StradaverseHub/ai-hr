// @vitest-environment jsdom
/** Board 2103041d: the PAT Inputs grid edits cells in place, counts and highlights changes, filters gaps and sends one
 * batch through "Review before saving" (board 60f1fdcd: no second-person confirmation). */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const actions=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),importPreview:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/rewards/pat-inputs/actions',()=>({previewPatBatchAction:actions.preview,savePatBatchAction:actions.save,previewPatImportAction:actions.importPreview}));
import {PatGrid,type PatGridCompany} from '../app/admin/rewards/pat-inputs/editor';

const version=(id:string,revision:number,state:'pending'|'confirmed',inputs:{targetCents:number|null;forecastCents:number|null;actualCents:number|null;targetMonthsBp:number})=>({id,revision,state,inputs,createdByName:'Fictional maker',confirmedByName:state==='confirmed'?'Fictional maker':null,confirmedAt:state==='confirmed'?'2026-11-01T00:00:00Z':null,reason:'Fictional reason'});
const companies:PatGridCompany[]=[
 {id:'11111111-1111-4111-8111-000000000001',name:'Alpha Fictional Sdn Bhd',groupId:'g1',groupName:'Fictional Group',buId:'bu1',buName:'Construction',latestRevision:1,active:version('v1',1,'confirmed',{targetCents:1_000_000,forecastCents:900_000,actualCents:1_100_000,targetMonthsBp:20000}),draft:null,history:[version('v1',1,'confirmed',{targetCents:1_000_000,forecastCents:900_000,actualCents:1_100_000,targetMonthsBp:20000})]},
 {id:'11111111-1111-4111-8111-000000000002',name:'Beta Fictional Sdn Bhd',groupId:'g1',groupName:'Fictional Group',buId:'bu1',buName:'Construction',latestRevision:0,active:null,draft:null,history:[]},
 {id:'11111111-1111-4111-8111-000000000003',name:'Gamma Fictional Sdn Bhd',groupId:'g1',groupName:'Fictional Group',buId:'bu2',buName:'Property',latestRevision:2,active:version('v2',1,'confirmed',{targetCents:500_000,forecastCents:null,actualCents:null,targetMonthsBp:20000}),draft:version('v3',2,'pending',{targetCents:600_000,forecastCents:null,actualCents:null,targetMonthsBp:20000}),history:[]},
];
const copies={en,ms,zh,ta,th,vi:viCopy};
afterEach(()=>{cleanup();vi.clearAllMocks();});
const show=(locale:keyof typeof copies='en')=>render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><PatGrid year={2026} companies={companies}/></NextIntlClientProvider>);

describe('PAT Inputs grid',()=>{
 it('groups companies with BU subtotals and summarises the gaps',()=>{
  show();
  expect(screen.getByText('1 of 3 companies complete · 2 missing Actual PAT · 1 missing Target PAT')).toBeTruthy();
  expect(screen.getByText('Construction subtotal')).toBeTruthy();expect(screen.getByText('Property subtotal')).toBeTruthy();
  // Beta has no target, so the Construction subtotal is not a partial sum.
  const construction=screen.getByText('Construction subtotal').closest('tr')!;
  expect(within(construction).getAllByText('—').length).toBeGreaterThan(0);
  const property=screen.getByText('Property subtotal').closest('tr')!;
  expect(within(property).getByText('6,000.00')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'Gamma Fictional Sdn Bhd Target PAT'})).toHaveValue('6000.00');
 });
 it('filters to missing rows, counts and highlights changed cells and marks invalid values',()=>{
  show();
  // Missing only hides the complete company and keeps the ones with gaps.
  fireEvent.click(screen.getByRole('checkbox',{name:'Missing only'}));
  expect(screen.queryByText('Alpha Fictional Sdn Bhd')).toBeNull();
  expect(screen.getByText('Beta Fictional Sdn Bhd')).toBeTruthy();expect(screen.getByText('Gamma Fictional Sdn Bhd')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox',{name:'Missing only'}));
  const actual=screen.getByRole('textbox',{name:'Beta Fictional Sdn Bhd Actual PAT'});
  fireEvent.change(screen.getByRole('textbox',{name:'Beta Fictional Sdn Bhd Target PAT'}),{target:{value:'2000'}});
  fireEvent.change(actual,{target:{value:'2500.50'}});
  expect(screen.getByRole('button',{name:'Save and make active (2)'})).toBeTruthy();
  expect(actual.className).toMatch(/border-primary/);
  fireEvent.change(screen.getByRole('textbox',{name:'Alpha Fictional Sdn Bhd Target PAT'}),{target:{value:'12.345'}});
  expect(screen.getByRole('textbox',{name:'Alpha Fictional Sdn Bhd Target PAT'})).toHaveAttribute('aria-invalid','true');
  // An invalid row counts as a gap.
  fireEvent.click(screen.getByRole('checkbox',{name:'Missing only'}));
  expect(screen.getByText('Alpha Fictional Sdn Bhd')).toBeTruthy();
 });
 it('refuses to save invalid figures and sends one batch with the reviewed digest and reason',async()=>{
  const summary={area:'pat',itemLabel:'PAT 2026 · 2 companies',lines:[{key:'k',label:'Beta Fictional Sdn Bhd: Target PAT',before:null,after:'2000.00'}],changedCount:1,affected:[],highImpact:[]};
  actions.preview.mockResolvedValue({error:'',review:{summary,digest:'a'.repeat(64)}});
  actions.save.mockResolvedValue({ok:true,affected:0});
  show();
  fireEvent.change(screen.getByRole('textbox',{name:'Alpha Fictional Sdn Bhd Target PAT'}),{target:{value:'-5'}});
  fireEvent.click(screen.getByRole('button',{name:'Save and make active (0)'}));
  expect(screen.getByRole('alert').textContent).toBe('Correct the highlighted values in 1 company before saving.');
  expect(actions.preview).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox',{name:'Alpha Fictional Sdn Bhd Target PAT'}),{target:{value:'10000.00'}});
  fireEvent.change(screen.getByRole('textbox',{name:'Beta Fictional Sdn Bhd Target PAT'}),{target:{value:'2000'}});
  fireEvent.click(screen.getByRole('button',{name:'Save and make active (1)'}));
  await waitFor(()=>expect(actions.preview).toHaveBeenCalledTimes(1));
  // Active mode also carries Gamma's open draft so it becomes active in the same step.
  expect(actions.preview.mock.calls[0]).toEqual([2026,'active',[
   {companyId:companies[1].id,expectedRevision:0,inputs:{targetCents:200_000,forecastCents:null,actualCents:null,targetMonthsBp:20000}},
   {companyId:companies[2].id,expectedRevision:2,inputs:{targetCents:600_000,forecastCents:null,actualCents:null,targetMonthsBp:20000}}]]);
 });
 it.each(Object.keys(copies) as (keyof typeof copies)[])('renders the grid controls in %s',locale=>{
  show(locale);const t=copies[locale].rewardSetup;
  expect(screen.getByRole('checkbox',{name:t.gridMissingOnly})).toBeTruthy();
  expect(screen.getByRole('button',{name:t.copyLastYear})).toBeTruthy();
 });
});
