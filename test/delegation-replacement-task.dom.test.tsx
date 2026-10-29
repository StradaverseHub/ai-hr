/** @vitest-environment jsdom */
/** Real delegation scope controls in six locales, with CI-only desktop/mobile Chrome captures. Fictional
 * reason; this is component rendering and form-data evidence, not an authenticated server journey. */
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import {DelegationScopePicker} from '../components/delegation-scope-picker';
import {DelegationOrgScopePicker} from '../components/delegation-org-scope-picker';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';
import ta from '../messages/ta.json';import th from '../messages/th.json';import vi from '../messages/vi.json';
const copies={en,ms,zh,ta,th,vi};
afterEach(cleanup);
describe('replacement leave delegation task and same-company default',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders and posts replacement leave as its own task',async locale=>{
  const copy=copies[locale].delegations;
  const view=render(<NextIntlClientProvider locale={locale} messages={copies[locale]} timeZone="Asia/Kuala_Lumpur">
   <main className="mx-auto w-full max-w-4xl"><form className="space-y-6">
    <DelegationScopePicker defaultReason="Fictional cover arrangement" defaultScopes={[{module:'leave',taskType:'leave.replacement'}]}/>
    <DelegationOrgScopePicker masters={{companies:[],businessUnits:[],departments:[]}}/>
   </form></main>
  </NextIntlClientProvider>);
  const task=screen.getByRole('checkbox',{name:copy.taskLabel.leaveReplacement}) as HTMLInputElement;
  expect(task.checked).toBe(true);expect(task.value).toBe('leave.replacement');
  const form=view.container.querySelector('form')!;
  expect(new FormData(form).getAll('scopeTask')).toEqual(['leave.replacement']);
  expect(new FormData(form).get('scopeCompanyId')).toBe('');
  expect(screen.getByRole('option',{name:copy.coverageAllCompanies})).toBeTruthy();
  expect(screen.getByText(copy.coverageHint)).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'delegation-replacement','real scope controls; fictional reason; no authenticated server journey');
  fireEvent.click(screen.getByRole('checkbox',{name:copy.moduleLabel.leave}));
  expect(screen.queryByRole('checkbox',{name:copy.taskLabel.leaveReplacement})).toBeNull();
  expect(new FormData(form).getAll('scopeTask')).toEqual([]);
 },120_000);
 it('explains the approved same-company default in the English option and help',()=>{
  expect(en.delegations.coverageAllCompanies).toBe("Stand-in’s company");
  expect(en.delegations.coverageHint).toContain('another company');
 });
});
