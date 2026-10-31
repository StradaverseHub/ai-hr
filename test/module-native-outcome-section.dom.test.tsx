/** @vitest-environment jsdom */
/** Authored UNRUN. Actual server composition; no provider/native effect calls are made by discovery. */
import React,{isValidElement,type ReactElement} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const copies:Record<string,typeof en>={en,ms,zh,ta,th,vi:viCopy};
const source=vi.hoisted(()=>({session:vi.fn(),locale:vi.fn(),workspace:vi.fn(),reopen:vi.fn(),notification:vi.fn(),record:vi.fn(),erase:vi.fn(),copyLocale:null as string|null}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:source.session}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>(key:string)=>{if(source.copyLocale===null)return key;let value:unknown=copies[source.copyLocale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing actual outcome translation');return value;},getLocale:source.locale}));
vi.mock('../core/module-native-outcome-workspace',()=>({loadOwnNativeOutcomeWorkspace:source.workspace}));
vi.mock('../core/module-native-outcomes',()=>({reopenOwnNativeOutcomeAssociation:source.reopen}));
vi.mock('../core/assistant-actions/own-notification-preferences-source',()=>({resolveOwnNotificationServerIdentity:source.notification}));
vi.mock('../app/(app)/assistant/native-outcome-actions',()=>({recordNativeOutcomeAction:source.record,reopenNativeOutcomeAction:vi.fn(),eraseNativeOutcomesAction:source.erase}));
import {NativeOutcomes,NativeOutcomePrivacy} from '../components/assistant/native-outcomes';
import {NativeOutcomeForm} from '../components/assistant/native-outcome-form';
const job='10000000-0000-4000-8000-000000000001',actionId='10000000-0000-4000-8000-000000000002',associationId='10000000-0000-4000-8000-000000000003';
const session=()=>({tenantId:job,userId:actionId,personId:associationId,roles:['employee'],grants:[{role:'employee',companyId:null as string|null}]});
const workspace=()=>({jobId:job,choices:[{reference:{source:'review',action:'leave.apply',actionId},createdAt:'2026-01-01T00:00:00.000Z'}],links:[{associationId,action:'leave.apply',createdAt:'2026-01-01T00:00:00.000Z'}],truncated:false});
function elements(value:unknown):ReactElement[]{if(Array.isArray(value))return value.flatMap(elements);if(!isValidElement(value))return[];return[value,...elements((value.props as {children?:unknown}).children)];}
beforeEach(()=>{vi.clearAllMocks();source.copyLocale=null;source.session.mockResolvedValue(session());source.locale.mockResolvedValue('en');source.workspace.mockResolvedValue(workspace());source.reopen.mockResolvedValue({associationId,action:'leave.apply',module:'leave',semantics:'submitted_not_approved',currentStatus:null,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z'});});afterEach(cleanup);
describe('selected own job outcome composition',()=>{
 it('captures selected session before locale awaits and never passes session, receipt or HR fields to its form',async()=>{
  const retained=session(),expected=structuredClone(retained);source.session.mockResolvedValueOnce(retained);source.locale.mockImplementationOnce(async()=>{retained.userId=job;retained.roles.push('super_admin');retained.grants[0].companyId=job;return'en';});
  const result=await NativeOutcomes({jobId:job}),form=elements(result).find(element=>element.type===NativeOutcomeForm)!;expect(source.workspace).toHaveBeenCalledWith(expected,job);expect(form).toBeTruthy();
  const props=form.props as {nonce:string;jobId:string;options:unknown};expect(props.nonce).toMatch(/^[a-f0-9-]{36}$/i);expect(props.jobId).toBe(job);expect(JSON.stringify(props.options)).not.toMatch(/roles|grants|balance|receipt|eventId|reason|currentStatus/);expect(source.reopen).not.toHaveBeenCalled();expect(source.record).not.toHaveBeenCalled();
 });
 it('retires consent state on each fresh server render and after authority failure',async()=>{
  const first=elements(await NativeOutcomes({jobId:job})).find(element=>element.type===NativeOutcomeForm)!,second=elements(await NativeOutcomes({jobId:job})).find(element=>element.type===NativeOutcomeForm)!;expect(first.key).not.toBe(second.key);
  source.workspace.mockRejectedValueOnce(Error('PRIVATE employment SQL'));const denied=await NativeOutcomes({jobId:job});render(denied);expect(screen.getByRole('alert')).toHaveTextContent('unavailable');expect(JSON.stringify(denied)).not.toContain('PRIVATE');expect(elements(denied).some(element=>element.type===NativeOutcomeForm)).toBe(false);
 });
 it('only reopens an actual selected own metadata link after discovery ends, not an arbitrary posted association',async()=>{
  render(await NativeOutcomes({jobId:job,selectedLink:associationId}));expect(source.reopen).toHaveBeenCalledExactlyOnceWith(session(),{associationId},{});expect(screen.getByText('checked')).toBeInTheDocument();expect(screen.getByText('action_leave_apply')).toBeInTheDocument();expect(source.record).not.toHaveBeenCalled();
  cleanup();render(await NativeOutcomes({jobId:job,selectedLink:actionId}));expect(source.reopen).toHaveBeenCalledTimes(1);expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
 });
 it('does not turn an edited saved query flag into an unverified success receipt',async()=>{render(await NativeOutcomes({jobId:job,status:'saved'}));expect(screen.queryByText('saved')).toBeNull();expect(source.reopen).not.toHaveBeenCalled();});
 it('keeps privacy erasure available without module, job or principal lookups in a denied branch',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}>{await NativeOutcomePrivacy({status:'erased'})}</NextIntlClientProvider>);expect(source.session).not.toHaveBeenCalled();expect(source.workspace).not.toHaveBeenCalled();expect(screen.getByText('erase')).toHaveAttribute('type','button');expect(screen.getByText('erased')).toHaveAttribute('role','status');expect(screen.getByText('erased').closest('details')).toBeNull();expect(document.querySelector('[name="personId"],[name="jobId"],[name="userId"]')).toBeNull();
 });
 it('covers strict selected-cookie authentication failure with the same bounded outward copy',async()=>{
  source.session.mockRejectedValueOnce(Error('PRIVATE cookie lookup'));const result=await NativeOutcomes({jobId:job});render(result);expect(screen.getByRole('alert')).toHaveTextContent('unavailable');expect(source.workspace).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('PRIVATE');
 });
});

const captionActions=[
 "org.position.archive",
 "org.department.archive",
 "org.employee_id_template.status",
 "org.people_general.change",
 "payroll.reopen",
 "payroll.reset",
 "performance.checkin.cancel",
 "performance.checkin.complete",
 "performance.checkin.schedule",
 "performance.goal.approve",
 "rewards.cancel_review",
 "rewards.calendar.update",
 "lifecycle.offboarding.step.complete",
 "lifecycle.offboarding.step.undo",
 "lifecycle.offboarding.case.cancel",
 "rewards.annual_review.return",
 "employees.compensation.maintain",
 "attendance.schedule_group.maintain",
 "employees.profile_request.reject",
 "attendance.day_schedule.correct",
 "employees.code.maintain",
 "employees.workforce_profile.maintain",
 "employees.bank.maintain",
 "employees.document_metadata.maintain",
 "employees.fixed_item.archive",
 "employees.cost_allocation.maintain",
 "employees.payment_method.maintain",
 "employees.tp3_opening.maintain",
 "employees.passport.maintain",
 "employees.emergency_contact.maintain",
 "employees.family.maintain",
 "employees.qualification.maintain",
 "employees.draft.discard",
 "employees.draft.activate",
 "rewards.post",
 "payroll.close"
] as const;
// Rendered trusted DTO/copy proof only: discovery/reopen are mocked, not backend authority or availability.
// Each independent cohort respects the actual25-choice/history bound and has distinct physical review IDs.
it.each(['en','ms','zh','ta','th','vi'])('%s renders all repaired actual captions in nonempty choices/history and a checked receipt',async locale=>{
 const references=captionActions.map((action,index)=>({associationId:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,sourceActionId:`30000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,action,createdAt:'2026-01-01T00:00:00.000Z'}));
 expect(new Set(references.map(row=>row.sourceActionId)).size).toBe(36);expect(new Set(references.map(row=>row.associationId)).size).toBe(36);
 expect(references.every(row=>row.sourceActionId!==row.associationId)).toBe(true);
 const cohorts=[references.slice(0,25),references.slice(25)];expect(cohorts.map(rows=>rows.length)).toEqual([25,11]);
 const covered=new Set<typeof captionActions[number]>(),native=copies[locale].assistant.workspace.nativeOutcomes as Record<string,string>;
 for(const [cohortIndex,rows] of cohorts.entries()){
  cleanup();vi.clearAllMocks();source.copyLocale=locale;source.session.mockResolvedValue(session());source.locale.mockResolvedValue(locale);
  const cohortJob=`40000000-0000-4000-8000-${String(cohortIndex+1).padStart(12,'0')}`;
  expect(rows.length).toBeGreaterThan(0);expect(rows.length).toBeLessThanOrEqual(25);
  const selected=rows.find(row=>row.action==='employees.bank.maintain')??rows[0];
  // Independent exact metadata for the selected canonical receipt in each cohort.
  const selectedMetadata=cohortIndex===0
   ?{action:'employees.bank.maintain',module:'employees',semantics:'bank_destination_saved_not_payment_processed_or_statutory_changed'}
   :{action:'employees.cost_allocation.maintain',module:'employees',semantics:'dated_distribution_replaced_or_cleared_no_payroll_recalculation'};
  expect(selected.action).toBe(selectedMetadata.action);
  source.workspace.mockResolvedValue({jobId:cohortJob,choices:rows.map(row=>({reference:{source:'review',action:row.action,actionId:row.sourceActionId},createdAt:row.createdAt})),links:rows.map(({associationId,action,createdAt})=>({associationId,action,createdAt})),truncated:false});
  source.reopen.mockResolvedValue({associationId:selected.associationId,...selectedMetadata,currentStatus:null,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z'});
  const {container}=render(<NextIntlClientProvider locale={locale} messages={copies[locale]}>{await NativeOutcomes({jobId:cohortJob,selectedLink:selected.associationId})}</NextIntlClientProvider>);
  const select=container.querySelector<HTMLSelectElement>('select')!;
  expect(select).toBeTruthy();expect(select.options).toHaveLength(rows.length+1);expect(select.value).toBe('');expect(container.querySelector('input[type="checkbox"]')).not.toBeChecked();
  expect([...select.options].slice(1).map(option=>JSON.parse(option.value).actionId)).toEqual(rows.map(row=>row.sourceActionId));
  for(const row of rows){
   const caption=native['action_'+row.action.replace(/[.-]/g,'_')];expect(caption).toBeTruthy();
   expect([...select.options].some(option=>option.textContent?.includes(caption))).toBe(true);
   const history=container.querySelector<HTMLInputElement>(`input[name="associationId"][value="${row.associationId}"]`)?.closest('form');expect(history).toBeTruthy();expect(history).toHaveTextContent(caption);covered.add(row.action);
  }
  const checked=screen.getByText(native.checked).closest('[role="status"]');expect(checked).toBeTruthy();expect(checked).toHaveTextContent(native['action_'+selected.action.replace(/[.-]/g,'_')]);expect(container.textContent).toContain(native.notQuality);
  expect(source.workspace).toHaveBeenCalledExactlyOnceWith(session(),cohortJob);expect(source.reopen).toHaveBeenCalledExactlyOnceWith(session(),{associationId:selected.associationId},{});expect(source.record).not.toHaveBeenCalled();expect(source.erase).not.toHaveBeenCalled();
  expect(container.textContent).not.toMatch(/action_org_position_archive|action_payroll_reset|assistant\.workspace/);
  expect(container.querySelector('[name="personId"],[name="salary"],[name="bankAccountNo"]')).toBeNull();
  cleanup();
 }
 expect([...covered]).toEqual([...captionActions]);
});
