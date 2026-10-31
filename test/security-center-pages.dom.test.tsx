/** Real page/component tree; fictional read owners. No live account writes. */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {Children,cloneElement,isValidElement,type ReactNode} from 'react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const copies={en,ms,zh,vi:viCopy,ta,th};
const m=vi.hoisted(()=>({locale:'en' as keyof typeof copies,access:{admin:true,configure:true,provision:true},load:vi.fn(),guard:vi.fn(),replace:vi.fn(),enabled:true}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);},useRouter:()=>({replace:m.replace,refresh:vi.fn()})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>m.locale,getTranslations:async(namespace:any)=>createTranslator({locale:m.locale,messages:copies[m.locale],namespace})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>m.guard(),isGroupAdmin:()=>m.access.provision}));
vi.mock('../lib/security-center-authz',()=>({requireSecurityCenter:async()=>({session:{},access:m.access}),requireGroupAdministration:async()=>m.guard()}));
vi.mock('../app/(app)/admin/users/data',()=>({loadUsersData:m.load,ROLES:['employee','hr_admin','super_admin']}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:()=>m.enabled}));
vi.mock('../lib/identity/config',()=>({keycloakSelected:()=>false}));
vi.mock('../app/(app)/admin/actions',()=>({inviteUserAction:vi.fn(),archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
vi.mock('../app/(app)/admin/users/manual-actions',()=>({createManualAccountAction:vi.fn(),resumeManualAccountAction:vi.fn(),cancelManualAccountAction:vi.fn()}));
import Hub from '../app/(app)/admin/security-center/page';
import Directory from '../app/(app)/admin/users/page';
import Create from '../app/(app)/admin/users/create/page';
import Invite from '../app/(app)/admin/users/invite/page';
import Functions from '../app/(app)/admin/users/function-access/page';
import {LegacySecurityNavigation} from '../app/(app)/admin/users/legacy-navigation';
const person={id:'11111111-2222-3333-4444-555555555555',name:'Fictional Person',email:'person@example.test',code:'F-001'};
/** Resolve only async server components; React renders client components and their hooks normally. */
async function serverTree(node:ReactNode):Promise<ReactNode>{
 if(!isValidElement<{children?:ReactNode}>(node))return node;
 if(typeof node.type==='function'&&node.type.constructor.name==='AsyncFunction')return serverTree(await (node.type as any)(node.props));
 const children=await Promise.all(Children.toArray(node.props.children).map(serverTree));
 return cloneElement(node,{},...children);
}
async function show(node:ReactNode){return render(<NextIntlClientProvider locale={m.locale} messages={copies[m.locale]} onError={error=>{throw error;}}>{await serverTree(node)}</NextIntlClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();m.locale='en';m.enabled=true;m.access={admin:true,configure:true,provision:true};m.guard.mockResolvedValue({tenantId:'fictional'});m.load.mockResolvedValue({rows:[],groupAdmin:true,companies:[],roleOptions:['employee'],assistantGranted:new Set(),peopleOptions:[person],pendingEmployees:[person],manualEnrollments:[]});window.history.replaceState(null,'','/admin/users');});
afterEach(cleanup);
describe('independent Security Center pages',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders the real overview with five authorized cards',async locale=>{
  m.locale=locale;await show(await Hub());expect(screen.getByRole('heading',{level:1,name:copies[locale].securityCenter.title})).toBeTruthy();
  expect(screen.getAllByRole('link')).toHaveLength(5);expect(m.load).not.toHaveBeenCalled();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),locale,'security-overview','real components; fictional read owners; no authenticated server journey','atelier');
 },60000);
 it('renders only configure-authorized cards without querying user data',async()=>{
  m.access={admin:false,configure:true,provision:false};await show(await Hub());expect(screen.getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/admin/users/access']);expect(m.load).not.toHaveBeenCalled();
 });
 it('keeps manual selected-person controls, password requirements, provider unavailable and success/error states',async()=>{
  await show(await Create({searchParams:Promise.resolve({activate:person.id,manualSuccess:'created'})}));
  expect(document.querySelector<HTMLInputElement>('input[name="personId"]')?.value).toBe(person.id);expect(document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(person.email);expect(document.querySelector<HTMLInputElement>('input[name="password"]')?.minLength).toBe(14);expect(document.querySelector<HTMLInputElement>('input[name="ownershipAttested"]')?.required).toBe(true);
  expect(screen.getByRole('status')).toHaveTextContent(en.admin.users.manual.success.created);expect(screen.queryByText(en.admin.users.inviteTitle)).toBeNull();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-create');
  cleanup();m.enabled=false;await show(await Create({searchParams:Promise.resolve({manualError:'unavailable'})}));expect(screen.getByText(en.admin.users.manual.notEnabled)).toBeTruthy();expect(document.querySelector('form')).toBeNull();expect(screen.getByRole('alert')).toBeTruthy();
 },60000);
 it('keeps invitation choices and success/errors on the invitation page',async()=>{
  await show(await Invite({searchParams:Promise.resolve({activate:person.id,saved:'1'})}));
  expect(screen.getByRole('status')).toHaveTextContent(en.securityCenter.invitationSent);expect(document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe(person.email);expect(document.querySelector('input[name="password"]')).toBeNull();expect(document.querySelector('a[href="/admin/users/invite"]')).toBeTruthy();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-invite');
  cleanup();await show(await Invite({searchParams:Promise.resolve({error:'Fictional invitation refusal'})}));expect(screen.getByRole('alert')).toHaveTextContent('Fictional invitation refusal');expect(screen.queryByRole('status')).toBeNull();
 },60000);
 it('renders a separate read-only guide, not permission-changing controls',async()=>{
  await show(await Functions());expect(screen.getByRole('table')).toBeTruthy();expect(document.querySelector('input[type="checkbox"]')).toBeNull();expect(document.querySelector('form')).toBeNull();expect(m.load).not.toHaveBeenCalled();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-functions');
 },60000);
 it('keeps the directory empty state and archived context without rendering account forms',async()=>{
  await show(await Directory({searchParams:Promise.resolve({archived:'1'})}));expect(screen.getByRole('searchbox')).toBeTruthy();expect(document.querySelector('input[name="password"]')).toBeNull();expect(document.querySelector('input[name="email"]')).toBeNull();
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en','security-users');
 },60000);
 it('rechecks authority before requesting page data and routes only recognized manual results',async()=>{
  m.guard.mockRejectedValue(new Error('denied'));for(const page of [Directory,Create,Invite])await expect(page({searchParams:Promise.resolve({})})).rejects.toThrow('denied');expect(m.load).not.toHaveBeenCalled();
  m.guard.mockResolvedValue({});await expect(Directory({searchParams:Promise.resolve({manualSuccess:'created'})})).rejects.toThrow('REDIRECT /admin/users/create?manualSuccess=created');expect(m.load).not.toHaveBeenCalled();
 });
 it('hands off only known old fragments, preserves invitation intent, and responds to history hash changes',()=>{
  window.history.replaceState(null,'',`/admin/users?activate=${person.id}&returnTo=https://foreign.test#invite-user`);render(<LegacySecurityNavigation/>);expect(m.replace).toHaveBeenLastCalledWith(`/admin/users/invite?activate=${person.id}`);
  window.history.replaceState(null,'',`/admin/users?activate=${person.id}#manual-account-setup`);fireEvent(window,new HashChangeEvent('hashchange'));expect(m.replace).toHaveBeenLastCalledWith(`/admin/users/create?activate=${person.id}`);
  m.replace.mockClear();window.history.replaceState(null,'','/admin/users#unrecognized');fireEvent(window,new HashChangeEvent('hashchange'));expect(m.replace).not.toHaveBeenCalled();
 });
});
