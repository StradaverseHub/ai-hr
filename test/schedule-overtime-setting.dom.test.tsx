/** 2f803985 (round 2) — the Overtime Setting section as rendered on Add and Edit Schedule Group: every control
 * the request names, its conditional fields (shown only with their parent), the companies and start date, and
 * all six locales rendering without a missing or failing message. */
import React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import {ScheduleOvertimeSettingFields,type ScheduleOvertimeSettingIslandProps} from '../components/schedule-overtime-setting';
import {defaultScheduleOvertimeSetting} from '../lib/schedule-overtime-setting';

const catalogues={en,ms,ta,th,vi:viMessages,zh};
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function props(over:Partial<ScheduleOvertimeSettingIslandProps>={}):ScheduleOvertimeSettingIslandProps{
 return {editing:true,initial:defaultScheduleOvertimeSetting(null),companies:[{id:id(1),name:'Fictional Alpha Sdn Bhd'},{id:id(2),name:'Fictional Beta Sdn Bhd'}],
  patterns:[{versionId:id(9),name:'Fictional OT 1.5',code:'OT15',companyIds:[id(1),id(2)]},{versionId:id(8),name:'Fictional Alpha only',code:null,companyIds:[id(1)]}],
  minimumDate:'2030-01-02',token:'f'.repeat(64),saved:null,...over};
}
function show(p=props(),locale:keyof typeof catalogues='en'){
 const errors:unknown[]=[];
 const view=render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><form><ScheduleOvertimeSettingFields {...p}/></form></NextIntlClientProvider>);
 return {errors,form:view.container.querySelector('form')!};
}
const words=en.scheduleOvertimeSetting;
afterEach(cleanup);

describe('Overtime Setting section',()=>{
 it('draws every control the request names, with no week dropdowns or old overtime bands',()=>{
  const {errors,form}=show();
  expect(errors).toEqual([]);
  for(const label of [words.beforeShift,words.afterShift,words.allowBackdated,words.splitAtMidnight,words.roundingMethod,words.roundingStep])
   expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(screen.getAllByText(words.offsetLateness).length).toBeGreaterThan(0);
  expect(screen.getAllByText(words.approvalTitle).length).toBeGreaterThan(0);
  const names=[...new FormData(form).keys()];
  expect(names).toEqual(expect.arrayContaining(['otSettingEditor','otSettingToken','otScope','otEffectiveFrom','otApproval','otRoundingMode','otRoundingStep']));
  expect(names.some(name=>/^createDayKind_|^otRows$/.test(name))).toBe(false);
  const steps=[...form.querySelectorAll<HTMLOptionElement>('select[name="otRoundingStep"] option')].map(o=>o.value);
  expect(steps).toEqual(['15','30','45']);
  expect([...form.querySelectorAll<HTMLOptionElement>('select[name="otRoundingMode"] option')].map(o=>o.value)).toEqual(['up','down']);
  expect([...form.querySelectorAll<HTMLOptionElement>('select[name="otApproval"] option')].map(o=>o.value)).toEqual(['manual','auto']);
  expect((form.querySelector('input[name="otEffectiveFrom"]') as HTMLInputElement).min).toBe('2030-01-02');
 });
 it('shows Show Lateness Exception After Offset only when Offset Overtime by Lateness is ticked',()=>{
  const {form}=show();
  expect(form.querySelector('input[name="otShowLatenessException"]')).toBeNull();
  fireEvent.click(form.querySelector('input[name="otOffsetLateness"]')!);
  const dependent=form.querySelector('input[name="otShowLatenessException"]') as HTMLInputElement;
  expect(dependent).not.toBeNull();
  fireEvent.click(dependent);
  expect(new FormData(form).get('otShowLatenessException')).toBe('on');
  fireEvent.click(form.querySelector('input[name="otOffsetLateness"]')!);
  expect(form.querySelector('input[name="otShowLatenessException"]'),'hidden again, and not posted').toBeNull();
  expect(new FormData(form).get('otShowLatenessException')).toBeNull();
 });
 it('shows Auto Overtime Approval Method and the per-day Overtime Patterns only for Auto, filtered to patterns active for every chosen company',()=>{
  const {form}=show();
  expect(form.querySelector('select[name="otAutoMethod"]')).toBeNull();
  expect(screen.getByText(words.approvalManualHint)).toBeVisible();
  fireEvent.change(form.querySelector('select[name="otApproval"]')!,{target:{value:'auto'}});
  const method=form.querySelector('select[name="otAutoMethod"]') as HTMLSelectElement;
  expect([...method.options].map(o=>o.textContent)).toEqual([words.methodIntersect,words.methodActual,words.methodPreApproved]);
  const normal=form.querySelector('select[name="otPattern_normal"]') as HTMLSelectElement;
  expect([...normal.options].map(o=>o.value),'All companies: only the pattern bound to both').toEqual(['',id(9)]);
  for(const key of ['normal','off','rest','publicHoliday','replacementHoliday'])expect(form.querySelector(`select[name="otPattern_${key}"]`)).not.toBeNull();
  fireEvent.click(form.querySelector('input[name="otScope"][value="companies"]')!);
  fireEvent.click(form.querySelector(`input[name="otCompanyIds"][value="${id(2)}"]`)!);
  expect([...(form.querySelector('select[name="otPattern_normal"]') as HTMLSelectElement).options].map(o=>o.value),'Alpha alone also offers its own').toEqual(['',id(9),id(8)]);
  fireEvent.change(form.querySelector('select[name="otApproval"]')!,{target:{value:'manual'}});
  expect(form.querySelector('select[name="otAutoMethod"]')).toBeNull();
 });
 it('warns when no pattern is active for every chosen company',()=>{
  const {form}=show(props({patterns:[]}));
  fireEvent.change(form.querySelector('select[name="otApproval"]')!,{target:{value:'auto'}});
  expect(screen.getByRole('alert')).toHaveTextContent(words.patternsNone);
 });
 it('reopens a saved setting exactly, read-only on View',()=>{
  const initial={...defaultScheduleOvertimeSetting(id(9)),beforeShift:true,splitAtMidnight:true,offsetLateness:true,showLatenessExceptionAfterOffset:true,
   approval:'auto' as const,autoMethod:'preApproved' as const,roundingMode:'up' as const,roundingStep:45 as const};
  const {form}=show(props({initial,saved:{effectiveFrom:'2030-01-01',differingCount:3,unsupportedRounding:false}}));
  expect((form.querySelector('input[name="otBeforeShift"]') as HTMLInputElement).checked).toBe(true);
  expect((form.querySelector('input[name="otAfterShift"]') as HTMLInputElement).checked).toBe(true);
  expect((form.querySelector('input[name="otAllowBackdated"]') as HTMLInputElement).checked).toBe(false);
  expect((form.querySelector('input[name="otSplitAtMidnight"]') as HTMLInputElement).checked).toBe(true);
  expect((form.querySelector('input[name="otShowLatenessException"]') as HTMLInputElement).checked).toBe(true);
  expect((form.querySelector('select[name="otAutoMethod"]') as HTMLSelectElement).value).toBe('preApproved');
  expect((form.querySelector('select[name="otRoundingMode"]') as HTMLSelectElement).value).toBe('up');
  expect((form.querySelector('select[name="otRoundingStep"]') as HTMLSelectElement).value).toBe('45');
  expect((form.querySelector('select[name="otPattern_rest"]') as HTMLSelectElement).value).toBe(id(9));
  expect(screen.getByText(words.savedFrom.replace('{date}','2030-01-01'))).toBeVisible();
  cleanup();
  const view=show(props({initial,editing:false}));
  expect(view.form.querySelectorAll('input,select')).toHaveLength(0);
  expect(screen.getByText(words.methodPreApproved)).toBeVisible();
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders every message in %s with Auto and the offset open',locale=>{
  const {errors,form}=show(props(),locale);
  fireEvent.change(form.querySelector('select[name="otApproval"]')!,{target:{value:'auto'}});
  fireEvent.click(form.querySelector('input[name="otOffsetLateness"]')!);
  expect(errors).toEqual([]);
  const local=catalogues[locale].scheduleOvertimeSetting;
  expect(screen.getAllByText(local.showLatenessException).length).toBeGreaterThan(0);
  expect(screen.getAllByText(local.autoMethod).length).toBeGreaterThan(0);
  if(locale!=='en')expect(local.title).not.toBe(en.scheduleOvertimeSetting.title);
 });
});
