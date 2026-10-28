/** @vitest-environment jsdom */
/** Authored UNRUN. Actual server composition; no provider/native effect calls are made by discovery. */
import React,{isValidElement,type ReactElement} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const source=vi.hoisted(()=>({session:vi.fn(),locale:vi.fn(),workspace:vi.fn(),reopen:vi.fn(),notification:vi.fn(),record:vi.fn(),erase:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:source.session}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key,getLocale:source.locale}));
vi.mock('../core/module-native-outcome-workspace',()=>({loadOwnNativeOutcomeWorkspace:source.workspace}));
vi.mock('../core/module-native-outcomes',()=>({reopenOwnNativeOutcomeAssociation:source.reopen}));
vi.mock('../core/assistant-actions/own-notification-preferences-source',()=>({resolveOwnNotificationServerIdentity:source.notification}));
vi.mock('../app/assistant/native-outcome-actions',()=>({recordNativeOutcomeAction:source.record,reopenNativeOutcomeAction:vi.fn(),eraseNativeOutcomesAction:source.erase}));
import {NativeOutcomes,NativeOutcomePrivacy} from '../components/assistant/native-outcomes';
import {NativeOutcomeForm} from '../components/assistant/native-outcome-form';
const job='10000000-0000-4000-8000-000000000001',actionId='10000000-0000-4000-8000-000000000002',associationId='10000000-0000-4000-8000-000000000003';
const session=()=>({tenantId:job,userId:actionId,personId:associationId,roles:['employee'],grants:[{role:'employee',companyId:null as string|null}]});
const workspace=()=>({jobId:job,choices:[{reference:{source:'review',action:'leave.apply',actionId},createdAt:'2026-01-01T00:00:00.000Z'}],links:[{associationId,action:'leave.apply',createdAt:'2026-01-01T00:00:00.000Z'}],truncated:false});
function elements(value:unknown):ReactElement[]{if(Array.isArray(value))return value.flatMap(elements);if(!isValidElement(value))return[];return[value,...elements((value.props as {children?:unknown}).children)];}
beforeEach(()=>{vi.clearAllMocks();source.session.mockResolvedValue(session());source.locale.mockResolvedValue('en');source.workspace.mockResolvedValue(workspace());source.reopen.mockResolvedValue({associationId,action:'leave.apply',module:'leave',semantics:'submitted_not_approved',currentStatus:null,association:'human_linked_verified_native_outcome',causalCredit:false,quality:'not_assessed',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-02T00:00:00.000Z'});});afterEach(cleanup);
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
