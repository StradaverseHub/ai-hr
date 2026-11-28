/** Board 0735d1b7 — the account page opened by View/Edit (app/admin/users/[userId]/account/page.tsx): Account information,
 * Account actions filtered by the account's status, Edit account information (everything the old in-list panel held)
 * and Security history. Real page and components; fictional read owners (their own DB tests cover them). It proves:
 *  - only the actions that fit the status are shown (active, suspended, expired, archived, left, merged away, setup);
 *  - Unlock Password Account appears only while the password is locked, says when, and only for a group administrator;
 *  - User Type, AI assistant access and Archive are group-administrator controls;
 *  - a login whose credential the administrator may not manage still shows its summary and roles with the reason;
 *  - the role, assistant and archive forms post back to this page (returnTo), never to another account;
 *  - passwordLockedAt applies the Password Policy's automatic unlock window exactly as sign-in admission does. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const m=vi.hoisted(()=>({group:true,internal:true,overview:vi.fn(),account:vi.fn(),history:vi.fn(),merge:vi.fn()}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NEXT_NOT_FOUND');},redirect:(p:string)=>{throw new Error('REDIRECT '+p);},useRouter:()=>({replace:vi.fn(),refresh:vi.fn()})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace?:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'fictional',userId:'admin'}),isGroupAdmin:()=>m.group}));
vi.mock('../lib/internal-auth/config',async importOriginal=>({...await importOriginal<typeof import('../lib/internal-auth/config')>(),internalSelected:()=>m.internal}));
vi.mock('../core/account-management',async importOriginal=>({...await importOriginal<typeof import('../core/account-management')>(),
 readAccountOverview:m.overview,readManagedAccount:m.account,readManagedAccountHistory:m.history}));
vi.mock('../core/last-sign-in',()=>({readLastSignIns:async()=>({'11111111-1111-4111-8111-111111111111':'2026-11-10T01:30:00.000Z'})}));
vi.mock('../core/login-merge',()=>({readLoginMergeState:m.merge}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:'acme',name:'Fictional Acme'}],adminCompanies:async()=>[{id:'acme',name:'Fictional Acme'}]}));
vi.mock('../app/admin/users/security-page',()=>({SecurityPageHeader:({title}:{title:string})=><h1>{title}</h1>}));
vi.mock('../app/admin/users/[userId]/account/merge-panel',()=>({LoginMergePanel:({state}:{state:unknown})=><div data-testid="merge-panel" data-state={JSON.stringify(state??null)}/>}));
vi.mock('../app/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
vi.mock('../app/admin/users/password-unlock-actions',()=>({unlockPasswordAccountAction:vi.fn()}));
vi.mock('../app/admin/users/[userId]/account/actions',()=>({accountAction:vi.fn(async()=>({status:'saved'})),generatePasswordAction:vi.fn(),accountHistoryAction:vi.fn(async()=>({status:'ok',entries:[]}))}));
vi.mock('../app/admin/users/data',()=>({ROLES:['employee','hr_admin']}));
import AccountPage from '../app/admin/users/[userId]/account/page';
import {passwordLockedAt} from '../core/account-management';

const ID='11111111-1111-4111-8111-111111111111';
const overview=(change:Record<string,unknown>={})=>({id:ID,personId:'p',name:'Fictional Aina',email:'aina@example.test',loginSuffix:null,archivedAt:null,leftEmployment:false,
 hasEmployment:true,employeeCode:'E0012',profileEmploymentId:'emp-1',roles:[{id:'r1',role:'employee',companyId:null,company:null},{id:'r2',role:'hr_admin',companyId:'acme',company:'Fictional Acme'}],assistantGranted:false,...change});
const account=(change:Record<string,unknown>={})=>({name:'Fictional Aina',username:'aina.r',email:'aina@example.test',status:'active',activeUntil:null,mustChange:false,temporaryPasswordExpiresAt:null,exemptionUntil:null,lockedAt:null,...change});
const a=en.accountManagement,u=en.admin.users,d=en.admin.users.directory;
async function show(){return render(<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}>{await AccountPage({params:Promise.resolve({userId:ID})})}</NextIntlClientProvider>);}
const section=(name:string)=>screen.getByRole('heading',{level:2,name}).closest('section') as HTMLElement;
const buttons=(el:HTMLElement)=>within(el).queryAllByRole('button').map(b=>b.textContent);
beforeEach(()=>{vi.clearAllMocks();m.group=true;m.internal=true;m.overview.mockResolvedValue(overview());m.account.mockResolvedValue(account());m.history.mockResolvedValue([]);m.merge.mockResolvedValue({mergedInto:null,mergedLogins:[],history:[]});});
afterEach(cleanup);

describe('account page sections and status-filtered actions (board 0735d1b7)',()=>{
 it('active, locked, group administrator: every active action, Unlock with its time, and the full Edit section',async()=>{
  m.account.mockResolvedValue(account({lockedAt:Date.UTC(2026,10,20,2,15)}));
  await show();
  const info=section(a.section.information);
  for(const text of ['E0012','aina.r','aina@example.test',d.userTypeValue.internal,d.tier.active,'10-Nov-2026 09:30'])expect(within(info).getByText(text)).toBeTruthy();
  expect(within(info).getByRole('link',{name:a.openPersonnelProfile})).toHaveAttribute('href','/admin/personnel/emp-1');
  const actions=section(a.section.actions);
  expect(buttons(actions)).toEqual([a.resetPassword.open,a.authenticator.open,a['reset-email'],en.passwordPolicy.full.unlockAction]);
  expect(within(actions).getByText('The password has been locked since 20-Nov-2026 10:15 after too many failed sign-in attempts.')).toBeTruthy();
  expect([...actions.querySelectorAll<HTMLInputElement>('input[name="userId"]')].every(i=>i.value===ID)).toBe(true);
  const edit=section(a.section.edit);
  expect(buttons(edit)).toEqual([`${d.remove}`,`${d.remove}`,u.addRole,a.suspend,a.expiry,u.assistantGrant,u.archive]);
  // Every form on this page posts back to this account only.
  const returnTos=[...edit.querySelectorAll<HTMLInputElement>('input[name="returnTo"]')].map(i=>i.value);
  expect(returnTos.length).toBe(5);expect(new Set(returnTos)).toEqual(new Set([`/admin/users/${ID}/account`]));
  expect([...edit.querySelectorAll<HTMLInputElement>('input[name="appUserId"]')].every(i=>i.value===ID)).toBe(true);
  expect(screen.getByTestId('merge-panel')).toBeTruthy();
 });
 it('shows Unlock only while the password is locked, and never to a company-level administrator',async()=>{
  await show();expect(screen.queryByRole('button',{name:en.passwordPolicy.full.unlockAction})).toBeNull();cleanup();
  m.group=false;m.merge.mockClear();m.account.mockResolvedValue(account({lockedAt:Date.now()-60_000}));await show();
  expect(screen.queryByRole('button',{name:en.passwordPolicy.full.unlockAction})).toBeNull();
  // Company-level administrators: no User Type, no assistant or archive, no merge facts read; scoped roles stay.
  expect(screen.queryByText(d.userTypeColumn)).toBeNull();
  expect(screen.queryByRole('button',{name:u.archive})).toBeNull();expect(screen.queryByRole('button',{name:u.assistantGrant})).toBeNull();
  expect(m.merge).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:d.removeRole.replace('{role}','hr admin').replace('{scope}','Fictional Acme')})).toBeTruthy();
  expect(screen.queryByRole('button',{name:d.removeRole.replace('{role}','employee').replace('{scope}',u.groupWide)})).toBeNull();
 });
 it('suspended: Reactivate and the active-until date only',async()=>{
  m.account.mockResolvedValue(account({status:'suspended'}));await show();
  expect(within(section(a.section.information)).getByText(a.statusDetail.suspended)).toBeTruthy();
  expect(buttons(section(a.section.actions))).toEqual([a.reactivate]);
  expect(buttons(section(a.section.edit))).toEqual([a.expiry,u.assistantGrant,u.archive]);
 });
 it('expired: explains and offers only the active-until date',async()=>{
  m.account.mockResolvedValue(account({status:'expired'}));await show();
  expect(within(section(a.section.actions)).getByText(a.expiredHelp)).toBeTruthy();expect(buttons(section(a.section.actions))).toEqual([]);
  expect(buttons(section(a.section.edit))).toEqual([a.expiry,u.assistantGrant,u.archive]);
 });
 it('archived by an administrator: Restore; merged away: no Restore (Undo merge lives in the merge section)',async()=>{
  m.overview.mockResolvedValue(overview({archivedAt:'2026-11-01T00:00:00.000Z'}));await show();
  expect(buttons(section(a.section.actions))).toEqual([u.restore]);
  expect(section(a.section.actions).querySelector<HTMLInputElement>('input[name="archived"]')?.value).toBe('false');
  expect(buttons(section(a.section.edit))).toEqual([u.assistantGrant]);cleanup();
  m.merge.mockResolvedValue({mergedInto:{id:'merge-1',masterId:'master'},mergedLogins:[],history:[]});await show();
  expect(buttons(section(a.section.actions))).toEqual([]);expect(within(section(a.section.actions)).getByText(a.mergedHelp)).toBeTruthy();
  expect(buttons(section(a.section.edit))).toEqual([]);
  expect(JSON.parse(screen.getByTestId('merge-panel').dataset.state!)).toMatchObject({mergedInto:{id:'merge-1'}});
 });
 it('a leaver explains why the login is closed and offers no restore',async()=>{
  m.overview.mockResolvedValue(overview({leftEmployment:true}));await show();
  const actions=section(a.section.actions);
  expect(within(actions).getByText(`${u.archivedCauseLeft} ${a.leftHelp}`)).toBeTruthy();expect(buttons(actions)).toEqual([]);
  expect(within(section(a.section.information)).getByText(a.statusDetail.left)).toBeTruthy();
 });
 it('setup pending: Resume setup only',async()=>{
  m.account.mockResolvedValue(account({status:'preparing'}));await show();
  const actions=section(a.section.actions);
  expect(within(actions).getByRole('link',{name:u.resumeActivation})).toHaveAttribute('href','/admin/users/create');expect(buttons(actions)).toEqual([]);
  expect(buttons(section(a.section.edit))).toEqual([]);
 });
 it('a login outside the administrator’s credential scope still shows its summary and roles with the reason',async()=>{
  m.account.mockRejectedValue(new Error('forbidden'));m.history.mockRejectedValue(new Error('forbidden'));await show();
  expect(within(section(a.section.actions)).getByText(d.unavailableScope)).toBeTruthy();
  expect(screen.queryByRole('button',{name:a.resetPassword.open})).toBeNull();
  expect(within(section(a.section.edit)).getAllByText('Fictional Acme').length).toBeGreaterThan(0);
  expect(screen.queryByRole('heading',{name:a.history})).toBeNull();cleanup();
  m.internal=false;await show();expect(within(section(a.section.actions)).getByText(d.unavailableProvider)).toBeTruthy();
 });
 it('an External User and a login the administrator cannot see',async()=>{
  m.overview.mockResolvedValue(overview({hasEmployment:false,profileEmploymentId:null,employeeCode:null}));await show();
  expect(within(section(a.section.information)).getByText(d.userTypeValue.external)).toBeTruthy();
  expect(screen.queryByRole('link',{name:a.openPersonnelProfile})).toBeNull();cleanup();
  m.overview.mockResolvedValue(null);await expect(AccountPage({params:Promise.resolve({userId:ID})})).rejects.toThrow('NEXT_NOT_FOUND');
 });
});

describe('passwordLockedAt',()=>{
 const on={lockoutEnabled:true,autoUnlock:false,unlockMinutes:15};
 it('follows the Password Policy and the automatic unlock window',()=>{
  const at=Date.UTC(2026,10,20,2,0);
  expect(passwordLockedAt(null,on,at)).toBeNull();
  expect(passwordLockedAt({attempts:2,lockedAt:null},on,at)).toBeNull();
  expect(passwordLockedAt({attempts:5,lockedAt:at},on,at+86_400_000)).toBe(at);
  expect(passwordLockedAt({attempts:5,lockedAt:at},{...on,lockoutEnabled:false},at)).toBeNull();
  expect(passwordLockedAt({attempts:5,lockedAt:at},undefined,at)).toBeNull();
  expect(passwordLockedAt({attempts:5,lockedAt:at},{...on,autoUnlock:true},at+14*60_000)).toBe(at);
  expect(passwordLockedAt({attempts:5,lockedAt:at},{...on,autoUnlock:true},at+15*60_000)).toBeNull();
 });
});
