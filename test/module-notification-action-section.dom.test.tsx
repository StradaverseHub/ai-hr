/** @vitest-environment jsdom */
/** Authored UNRUN: isolated server composition, not actual cookie/DB/CSRF acceptance. */
import React from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ModuleNotificationActionSection} from '../components/assistant/module-notification-action-section';
import AssistantNotificationPreferencesPage from '../app/(app)/assistant/notifications/page';
const source=vi.hoisted(()=>({session:vi.fn(),choices:vi.fn(),locale:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key),getLocale:source.locale}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:source.session}));
vi.mock('../core/assistant-actions/module-action-server',()=>({readNotificationModuleActionChoices:source.choices}));
vi.mock('../components/assistant/module-notification-action-panel',()=>({ModuleNotificationActionPanel:()=>null}));
vi.mock('next/link',()=>({default:()=>null}));
vi.mock('../components/ui',()=>({Card:()=>null,PageHeader:()=>null}));
const user='10000000-0000-4000-8000-000000000001',person='10000000-0000-4000-8000-000000000002',tenant='10000000-0000-4000-8000-000000000003',employment='10000000-0000-4000-8000-000000000004',review='10000000-0000-4000-8000-000000000005';
const session=()=>({tenantId:tenant,userId:user,personId:person,roles:['employee'],grants:[{role:'employee',companyId:null}]}),choices=()=>({kind:'choices',employments:[{employmentId:employment,employeeCode:'F001',companyName:'Fictional Company'}]});
beforeEach(()=>{vi.clearAllMocks();source.session.mockResolvedValue(session());source.choices.mockResolvedValue(choices());source.locale.mockResolvedValue('en');});
function allElements(node:React.ReactNode):React.ReactElement[]{if(!React.isValidElement(node))return[];const props=node.props as {children?:React.ReactNode};return[node,...React.Children.toArray(props.children).flatMap(child=>allElements(child))];}
describe('current-principal Notification action composition',()=>{
 it('uses only strict server session/current choices, passing no actor/grants/executor/private fingerprint to the panel',async()=>{
  const result=await ModuleNotificationActionSection({resumeActionId:review});expect(source.session).toHaveBeenCalledTimes(1);expect(source.choices).toHaveBeenCalledWith(session());expect(Object.keys(result.props).sort()).toEqual(['choices','resumeActionId']);expect(result.props.resumeActionId).toBe(review);expect(result.key).toMatch(/^[a-f0-9]{64}$/);expect(String(result.key)).not.toContain(user);expect(result.props.choices).toEqual(choices());
 });
 it('resets opaque client lifetime for changed principal, grants, locale or resume and for a fresh unavailable/changed own-choice set',async()=>{
  const first=await ModuleNotificationActionSection();source.choices.mockResolvedValue({kind:'unavailable'});const revoked=await ModuleNotificationActionSection();expect(revoked.props.choices).toEqual({kind:'unavailable'});expect(revoked.key).not.toBe(first.key);source.choices.mockResolvedValue({kind:'choices',employments:[{...choices().employments[0],companyName:'Changed permitted company label'}]});const relabelled=await ModuleNotificationActionSection();expect(relabelled.key).not.toBe(first.key);source.choices.mockResolvedValue(choices());source.session.mockResolvedValue({...session(),grants:[{role:'employee',companyId:tenant}]});const rescoped=await ModuleNotificationActionSection();expect(rescoped.key).not.toBe(first.key);source.session.mockResolvedValue({...session(),userId:review});const relogged=await ModuleNotificationActionSection();expect(relogged.key).not.toBe(first.key);source.session.mockResolvedValue(session());source.locale.mockResolvedValue('ms');const language=await ModuleNotificationActionSection();expect(language.key).not.toBe(first.key);source.locale.mockResolvedValue('en');const resumed=await ModuleNotificationActionSection({resumeActionId:review});expect(resumed.key).not.toBe(first.key);
 });
 it('captures all selected-session identity and nested grants before the locale await can mutate the retained object',async()=>{
  const retained={...session(),grants:[{role:'employee',companyId:null as string|null}]},captured=session();source.session.mockResolvedValue(retained);source.locale.mockImplementationOnce(async()=>{retained.userId=review;retained.personId=review;retained.tenantId=review;retained.roles.push('hr_admin');retained.grants[0].role='hr_admin';retained.grants.push({role:'employee',companyId:tenant});return'en';});
  const result=await ModuleNotificationActionSection();expect(source.choices).toHaveBeenCalledWith(captured);source.session.mockResolvedValue(captured);source.locale.mockResolvedValue('en');const unchanged=await ModuleNotificationActionSection();expect(result.key).toBe(unchanged.key);
 });
 it('retains the opaque lifetime for equivalent role/grant order while resetting it for an actual grant change',async()=>{
  source.session.mockResolvedValue({...session(),roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:tenant}]});const first=await ModuleNotificationActionSection();source.session.mockResolvedValue({...session(),roles:['hr_admin','employee'],grants:[{role:'hr_admin',companyId:tenant},{role:'employee',companyId:null}]});const reordered=await ModuleNotificationActionSection();expect(reordered.key).toBe(first.key);source.session.mockResolvedValue({...session(),roles:['hr_admin','employee'],grants:[{role:'hr_admin',companyId:null},{role:'employee',companyId:null}]});expect((await ModuleNotificationActionSection()).key).not.toBe(first.key);
 });
 it('canonicalizes only choice ordering in the key, without dropping distinct permitted identities',async()=>{
  const second={employmentId:review,employeeCode:'F002',companyName:'Second fictional company'};source.choices.mockResolvedValue({kind:'choices',employments:[choices().employments[0],second]});const first=await ModuleNotificationActionSection();source.choices.mockResolvedValue({kind:'choices',employments:[second,choices().employments[0]]});const reordered=await ModuleNotificationActionSection();expect(reordered.key).toBe(first.key);source.choices.mockResolvedValue(choices());const fewer=await ModuleNotificationActionSection();expect(fewer.key).not.toBe(first.key);
 });
 it('rejects invalid/array resume input before authentication and refuses unknown cookie selection without fallback or made-up choices',async()=>{
  const invalid=await ModuleNotificationActionSection({resumeActionId:[review]});expect(source.session).not.toHaveBeenCalled();expect(allElements(invalid).some(node=>(node.props as {role?:string}).role==='alert')).toBe(true);source.session.mockRejectedValue(Error('PRIVATE authentication detail'));const unavailable=await ModuleNotificationActionSection();expect(source.choices).not.toHaveBeenCalled();expect(JSON.stringify(unavailable)).not.toContain('PRIVATE');expect(allElements(unavailable).some(node=>(node.props as {href?:string}).href==='/me/notifications')).toBe(true);
 });
 it('rejects malformed/duplicated choices instead of manufacturing an empty enabled form',async()=>{
  source.choices.mockResolvedValue({kind:'choices',employments:[choices().employments[0],choices().employments[0]]});const result=await ModuleNotificationActionSection();expect(allElements(result).some(node=>(node.props as {role?:string}).role==='alert')).toBe(true);expect((result.props as {choices?:unknown}).choices).toBeUndefined();
 });
 it('keeps GET page composition on the existing Notifications agent/manual path and does not execute an action',async()=>{
  const page=await AssistantNotificationPreferencesPage({searchParams:Promise.resolve({review})}),elements=allElements(page);expect(elements.some(node=>(node.props as {href?:string}).href==='/assistant?job=notifications')).toBe(true);expect(elements.some(node=>node.type===ModuleNotificationActionSection&&(node.props as {resumeActionId?:unknown}).resumeActionId===review)).toBe(true);expect(source.session).not.toHaveBeenCalled();expect(source.choices).not.toHaveBeenCalled();
 });
});

it('keeps login-only review recovery reachable after a removed Person link without loading native effect choices',async()=>{source.session.mockResolvedValue({...session(),personId:null});const result=await ModuleNotificationActionSection();expect(result.props.choices).toEqual({kind:'unavailable'});expect(source.choices).not.toHaveBeenCalled();expect(Object.keys(result.props)).not.toContain('ctx');expect(result.key).toMatch(/^[a-f0-9]{64}$/);});
