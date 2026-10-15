import React from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import type {OvertimeEvaluation,OvertimeLine,OvertimeValue} from '../lib/overtime-pattern-model';
import {OvertimeCalculationResult} from '../components/overtime-patterns/calculation-result';

const source={tenantId:'00000000-0000-4000-8000-000000000001',employmentId:'00000000-0000-4000-8000-000000000002',attendanceId:'00000000-0000-4000-8000-000000000003',date:'2026-10-15',inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)};
const earningId='00000000-0000-4000-8000-000000000004';
const quantity={unit:'minutes' as const,numerator:'60',denominator:'1'};
const measured:OvertimeValue={state:'known',value:quantity};
function line(id:string,sessionId:string):OvertimeLine {
 return {id,source,sessionId,segmentId:`${sessionId}:segment`,rateId:'rate',tierId:id,mapping:{earningItemId:earningId,currency:'MYR'},rawMinutes:measured,eligibleMinutes:measured,approvedMinutes:measured,payableMinutes:quantity,gross:{unit:'money',numerator:'25',denominator:'1'},adjusted:{unit:'money',numerator:'25',denominator:'1'},amountMinorUnits:'2500'};
}
function result(granularity?:'recorded'|'dayAggregate'):OvertimeEvaluation {
 return {status:'ready',source,patternVersionId:source.attendanceId,assignmentId:source.employmentId,transferable:true,currency:{code:'MYR',minorScale:2},rawMinutes:measured,eligibleMinutes:measured,approvedMinutes:measured,payableMinutes:quantity,amountMinorUnits:'2500',lines:[line('tier-one',`${source.attendanceId}:day`)],trace:granularity?[{kind:'duration',id:'input',data:{sessionGranularity:granularity}}]:[]};
}
const catalogues={en,ms,zh,ta,th,vi};
afterEach(cleanup);
describe('calculation presentation keeps human labels separate from immutable evidence',()=>{
 it.each(Object.entries(catalogues))('uses authorized earning copy and an honest day label in %s', (locale,messages)=>{
  const evaluation=result('dayAggregate');
  render(<NextIntlClientProvider locale={locale} messages={messages}><OvertimeCalculationResult result={evaluation} earningItems={[{id:earningId,label:'Fictional contractual OT'}]} preview={false}/></NextIntlClientProvider>);
  const cells=within(screen.getAllByRole('row')[1]).getAllByRole('cell');
  expect(cells[2].firstElementChild).toHaveTextContent(messages.overtimePatterns.bases.day);
  expect(cells[2].lastElementChild).toHaveTextContent(`${source.attendanceId}:day`);
  expect(cells[4].firstElementChild).toHaveTextContent('Fictional contractual OT');
  expect(cells[4].lastElementChild).toHaveTextContent(earningId);
  expect(cells[5]).toHaveTextContent('MYR 25.00');
 });
 it('numbers each immutable recorded session once across tiers without inferring from UUID suffixes',()=>{
  const evaluation=result('recorded');if(evaluation.status==='refused')throw Error('fixture');
  evaluation.lines=[line('tier-one','session-z'),line('tier-two','session-z'),line('tier-three','session-a')];
  const total={unit:'minutes' as const,numerator:'180',denominator:'1'};
  evaluation.rawMinutes=evaluation.eligibleMinutes=evaluation.approvedMinutes={state:'known',value:total};
  evaluation.payableMinutes=total;evaluation.amountMinorUnits='7500';
  render(<NextIntlClientProvider locale="en" messages={en}><OvertimeCalculationResult result={evaluation}/></NextIntlClientProvider>);
  const cells=screen.getAllByRole('row').slice(1).map(row=>within(row).getAllByRole('cell')[2]);
  expect(cells.map(cell=>cell.firstElementChild?.textContent)).toEqual(['Session 1','Session 1','Session 2']);
  expect(cells.map(cell=>cell.lastElementChild?.textContent)).toEqual(['session-z','session-z','session-a']);
 });
 it('keeps absent earning labels and absent session evidence Unknown with exact unavailable IDs',()=>{
  render(<NextIntlClientProvider locale="en" messages={en}><OvertimeCalculationResult result={result()}/></NextIntlClientProvider>);
  const cells=within(screen.getAllByRole('row')[1]).getAllByRole('cell');
  expect(cells[2].firstElementChild).toHaveTextContent(en.overtimePatterns.unknown);
  expect(cells[4].firstElementChild).toHaveTextContent(en.overtimePatterns.unknown);
  expect(cells[4].lastElementChild).toHaveTextContent(en.overtimePatterns.unavailableReference.replace('{id}',earningId));
  expect(screen.queryByText('Fictional contractual OT')).toBeNull();
 });
});
