// @vitest-environment jsdom
/** Board fc804e8c: the Limit Controls table renders every limit with its Value, Type, Applies to and last change in
 * every locale; Group Rewards edits and saves through "Review before saving" (board 60f1fdcd: no second person);
 * CTRO and EC see the same table read-only; fixed invariants are never editable. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const actions=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),previewReapply:vi.fn(),reapply:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/admin/rewards/limit-controls/actions',()=>({previewLimitSaveAction:actions.preview,saveLimitAction:actions.save,previewReapplyAction:actions.previewReapply,reapplyAction:actions.reapply}));
import {LimitControlsEditor,type LimitRow} from '../app/admin/rewards/limit-controls/editor';
import {LimitControlReviews} from '../app/admin/rewards/limit-controls/reviews';
import {baselineRewardLimitValues,rewardLimitDefinitions} from '../packs/rewards/limit-controls-model';
import {rewardConfigSummary} from '../packs/rewards/config-change-model';

const copies={en,ms,zh,ta,th,vi:viCopy};
const values=baselineRewardLimitValues();
const rows:LimitRow[]=rewardLimitDefinitions.map(d=>({key:d.key,area:d.area,unit:d.unit,appliesTo:d.appliesTo,fixed:'fixed' in d&&!!d.fixed,valueEditable:d.valueEditable,typeEditable:d.typeEditable,nullable:'nullable' in d&&!!d.nullable,value:values[d.key].value,type:values[d.key].type,
 changedBy:d.key==='bonus.poolCap'?'Fictional Mei Ong':null,changedAt:d.key==='bonus.poolCap'?'2026-11-12T02:00:00Z':null}));
const show=(canEdit:boolean,locale:keyof typeof copies='en')=>render(<NextIntlClientProvider locale={locale} messages={copies[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><LimitControlsEditor year={2026} revision={1} canEdit={canEdit} rows={rows}/></NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Limit Controls table',()=>{
 it('renders every limit in every locale',()=>{
  for(const locale of Object.keys(copies) as (keyof typeof copies)[]){show(false,locale);expect(screen.getAllByRole('row').length).toBe(rows.length+6+1);cleanup();}
 });
 it('shows the values, types, plans and last change read-only for CTRO and EC',()=>{
  show(false);
  expect(screen.getByRole('note').textContent).toBe('You can view these limits. Only Group Rewards can change them.');
  expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);expect(screen.queryAllByRole('combobox')).toHaveLength(0);expect(screen.queryByRole('button',{name:'Review before saving'})).toBeNull();
  const cap=screen.getByText('Bonus pool cap').closest('tr')!;
  expect(within(cap).getByText('100 %')).toBeTruthy();expect(within(cap).getByText('Block')).toBeTruthy();expect(within(cap).getByText('All plans')).toBeTruthy();expect(within(cap).getByText(/Fictional Mei Ong/)).toBeTruthy();
  const reduction=screen.getByText('No salary reduction').closest('tr')!;
  expect(within(reduction).getByText('Fixed')).toBeTruthy();expect(within(reduction).getByText('Block')).toBeTruthy();
  expect(screen.getAllByText('JG H plan')).toHaveLength(3);
 });
 it('lets Group Rewards change a value and a type and saves the reviewed version with a reason',async()=>{
  const summary=rewardConfigSummary({area:'limit',itemLabel:'Limit Controls 2026',lines:[{key:'increase.withoutPromotion:value',label:'Total increase without promotion · Value',before:'10%',after:'12%'}],highImpact:['released-limit']});
  actions.preview.mockResolvedValue({error:'',review:{summary,digest:'d'.repeat(64)}});actions.save.mockResolvedValue({ok:true,revision:2});
  show(true);
  const save=screen.getByRole('button',{name:'Review before saving'}) as HTMLButtonElement;expect(save.disabled).toBe(true);
  // Fixed rows and checks without a number have no value input; calculation settings have no type choice.
  expect(within(screen.getByText('No salary reduction').closest('tr')!).queryByRole('spinbutton')).toBeNull();
  expect(within(screen.getByText('CR catch-up floor for STAR/SSTAR').closest('tr')!).queryByRole('combobox')).toBeNull();
  fireEvent.change(screen.getByLabelText('Value for Total increase without promotion above'),{target:{value:'12'}});
  fireEvent.change(screen.getByLabelText('Type for Total increase without promotion above'),{target:{value:'exception'}});
  expect(save.disabled).toBe(false);fireEvent.click(save);
  await waitFor(()=>expect(actions.preview).toHaveBeenCalled());
  const [year,revision,sent]=actions.preview.mock.calls[0];
  expect([year,revision]).toEqual([2026,1]);expect(sent['increase.withoutPromotion']).toEqual({value:1200,type:'exception'});
  expect(sent['salary.noReduction']).toBeUndefined();expect(sent['lump.cap']).toEqual({value:null,type:'note'});expect(sent['lump.step']).toEqual({value:5000,type:'note'});
  await screen.findByText('A budget limit changes for a review that has already been released.');
  fireEvent.change(screen.getByLabelText('Reason for this change'),{target:{value:'Fictional Group Rewards decision'}});
  fireEvent.click(await screen.findByRole('button',{name:'Save new version',hidden:true}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(2026,1,sent,'Fictional Group Rewards decision','d'.repeat(64)));
  expect(await screen.findByText('Saved as version 2.')).toBeTruthy();
 });
 it('refuses an incomplete value before any request',()=>{
  show(true);
  fireEvent.change(screen.getByLabelText('Value for Rounding step'),{target:{value:''}});
  expect((screen.getByRole('button',{name:'Review before saving'}) as HTMLButtonElement).disabled).toBe(true);
  expect(actions.preview).not.toHaveBeenCalled();
 });
});

describe('reviews of the reward year',()=>{
 const reviews=[
  {reviewId:'00000000-0000-4000-8000-000000000001',label:'Alpha Fictional · Retail 2026',stage:'draft',released:true,pinned:false,pinnedRevision:null},
  {reviewId:'00000000-0000-4000-8000-000000000002',label:'Beta Fictional · Retail 2026',stage:'ctro',released:true,pinned:true,pinnedRevision:1},
  {reviewId:'00000000-0000-4000-8000-000000000003',label:'Gamma Fictional · Retail 2026',stage:'approved',released:true,pinned:true,pinnedRevision:1},
 ];
 const list=(canEdit:boolean)=>render(<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}><LimitControlReviews year={2026} revision={2} canEdit={canEdit} reviews={reviews} truncated={false}/></NextIntlClientProvider>);
 it('shows which version each review uses and offers re-application only for reviews in the approval route',()=>{
  list(true);
  expect(within(screen.getByText('Alpha Fictional · Retail 2026').closest('tr')!).getByText('Current (version 2)')).toBeTruthy();
  expect(within(screen.getByText('Beta Fictional · Retail 2026').closest('tr')!).getByText('Version 1')).toBeTruthy();
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox',{name:'Select Beta Fictional · Retail 2026'})).toBeTruthy();
  cleanup();list(false);expect(screen.queryAllByRole('checkbox')).toHaveLength(0);expect(screen.queryByRole('button')).toBeNull();
 });
});
