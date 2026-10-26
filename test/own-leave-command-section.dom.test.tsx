/** Server composition seams only, authored UNRUN. Current SQL/RLS/grant proof belongs to the actual
 * choices DB cases; these mocks verify the section cannot take authority/options from its props. */
import {randomUUID} from 'node:crypto';
import {isValidElement,type ReactElement,type ReactNode,type ComponentProps} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
const owners=vi.hoisted(()=>({session:vi.fn(),locale:vi.fn(),choices:vi.fn(),tenant:vi.fn()}));
vi.mock('../lib/session',()=>({getBrowserCommandSession:(...args:unknown[])=>owners.session(...args)}));
vi.mock('../db/client',()=>({withTenant:(ctx:unknown,work:(tx:unknown)=>unknown)=>owners.tenant(ctx,work)}));
vi.mock('../core/assistant-actions/own-leave-choices',()=>({readOwnLeaveChoicesTx:(...args:unknown[])=>owners.choices(...args)}));
vi.mock('next-intl/server',()=>({getLocale:()=>owners.locale(),getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'ownLeaveReview'})}));
vi.mock('next/link',()=>({default:({children,...props}:ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('../components/assistant/own-leave-command-panel',()=>({OwnLeaveCommandPanel:(props:Record<string,unknown>)=><output data-testid="panel">{JSON.stringify(props)}</output>}));
import {OwnLeaveCommandSection} from '../components/assistant/own-leave-command-section';
const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),employmentId=randomUUID(),leaveTypeId=randomUUID();
const tx={owned:'fixture transaction'};
const session=()=>({tenantId,userId,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]});
const choices={kind:'choices',employments:[{id:employmentId,label:'My fictional company · FICT-1',leaveTypes:[{id:leaveTypeId,label:'Annual'}]}]};
beforeEach(()=>{owners.session.mockResolvedValue(session());owners.locale.mockResolvedValue('en');owners.choices.mockResolvedValue(choices);owners.tenant.mockImplementation(async(_ctx:unknown,work:(tx:unknown)=>unknown)=>work(tx));});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function panel(node:ReactNode):ReactElement<{employments:unknown;messages:unknown;resumeActionId?:string}>|null{
 if(!isValidElement(node))return null;
 if('employments' in (node.props as Record<string,unknown>))return node as ReactElement<{employments:unknown;messages:unknown;resumeActionId?:string}>;
 const children=(node.props as{children?:ReactNode}).children;
 if(Array.isArray(children)){for(const child of children){const result=panel(child);if(result)return result;}return null;}
 return children?panel(children):null;
}
describe('unmounted real-session own-leave section composition',()=>{
 it('uses only actual command session/same transaction/current locale and serializes minimal menu/copy props',async()=>{
  const resume=randomUUID(),element=await OwnLeaveCommandSection({resumeActionId:resume,actor:{userId:'POSTED_FOREIGN_ACTOR'},employments:[{id:'POSTED_SUBJECT'}]} as never),client=panel(element)!;
  expect(owners.session).toHaveBeenCalledTimes(1);expect(owners.tenant).toHaveBeenCalledWith(session(),expect.any(Function));expect(owners.choices).toHaveBeenCalledWith(tx,session(),'en');
  expect(client.props).toEqual({employments:choices.employments,messages:en.ownLeaveReview.commands,resumeActionId:resume});
  expect(String(client.key)).toMatch(/^[a-f0-9]{64}$/);for(const secret of [tenantId,userId,personId,'POSTED_FOREIGN_ACTOR','POSTED_SUBJECT'])expect(JSON.stringify(client.props)+String(client.key)).not.toContain(secret);
  render(element);expect(screen.getByTestId('panel').textContent).toContain('My fictional company');
 });
 it('keys client memory by the real session identity and validated resume action, never a posted actor',async()=>{
  const first=panel(await OwnLeaveCommandSection())!;
  owners.session.mockResolvedValue({...session(),userId:randomUUID()});const differentUser=panel(await OwnLeaveCommandSection())!;expect(differentUser.key).not.toBe(first.key);
  owners.session.mockResolvedValue({...session(),tenantId:randomUUID()});expect(panel(await OwnLeaveCommandSection())!.key).not.toBe(first.key);
  owners.session.mockResolvedValue({...session(),personId:randomUUID()});expect(panel(await OwnLeaveCommandSection())!.key).not.toBe(first.key);
  owners.session.mockResolvedValue(session());expect(panel(await OwnLeaveCommandSection({resumeActionId:randomUUID()}))!.key).not.toBe(first.key);
 });
 it('resets private client state when the same login loses choices or its actual grant/allowed subject binding changes',async()=>{
  const first=panel(await OwnLeaveCommandSection())!;
  owners.choices.mockResolvedValueOnce({kind:'unavailable'});const denied=panel(await OwnLeaveCommandSection())!;expect(denied.key).not.toBe(first.key);expect(denied.props.employments).toEqual([]);
  owners.choices.mockResolvedValueOnce({...choices,employments:[{...choices.employments[0],id:randomUUID()}]});expect(panel(await OwnLeaveCommandSection())!.key).not.toBe(first.key);
  owners.session.mockResolvedValueOnce({...session(),grants:[{role:'employee',companyId:randomUUID()}]});expect(panel(await OwnLeaveCommandSection())!.key).not.toBe(first.key);
  expect(panel(await OwnLeaveCommandSection())!.key).toBe(first.key);
 });
 it('captures session carrier arrays before locale resolution can mutate the retained cache object',async()=>{
  const actual=session();owners.session.mockResolvedValue(actual);owners.locale.mockImplementationOnce(async()=>{actual.roles[0]='hr_admin';actual.grants[0].role='hr_admin';return'en';});
  await OwnLeaveCommandSection();expect(owners.choices).toHaveBeenCalledWith(tx,session(),'en');
 });
 it('retains explicit metadata recovery with no preparation choices when the actor/menu is unavailable',async()=>{
  owners.choices.mockResolvedValueOnce({kind:'unavailable'});const element=await OwnLeaveCommandSection({resumeActionId:randomUUID()}),client=panel(element)!;
  expect(client.props.employments).toEqual([]);render(element);expect(screen.getByRole('alert').textContent).toBe(en.ownLeaveReview.commands.unavailable);
 });
 it('returns only friendly bounded fallback for missing authentication, bad locale or malformed resume selector',async()=>{
  owners.session.mockRejectedValueOnce(Error('PRIVATE_COOKIE_SESSION_SENTINEL'));render(await OwnLeaveCommandSection());expect(screen.getByRole('alert').textContent).toBe(en.ownLeaveReview.commands.unavailable);expect(document.body.textContent).not.toContain('PRIVATE_COOKIE');expect(screen.queryByTestId('panel')).toBeNull();
  cleanup();owners.locale.mockResolvedValueOnce('invalid-locale');render(await OwnLeaveCommandSection());expect(screen.queryByTestId('panel')).toBeNull();expect(screen.getByRole('link').getAttribute('href')).toBe('/leave?apply=1');
  cleanup();owners.choices.mockClear();render(await OwnLeaveCommandSection({resumeActionId:'PRIVATE_MALFORMED_ACTION'}));expect(owners.choices).not.toHaveBeenCalled();expect(document.body.textContent).not.toContain('PRIVATE_MALFORMED_ACTION');
 });
});
