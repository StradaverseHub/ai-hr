/** @vitest-environment jsdom */
/** AI v2 W11 — the protected case route in the rail (ADR-0173), per role: every person gets "My private cases" beside
 * My workspace; "Private cases" (the handlers' queue) appears only for a login that handles private cases, which
 * app/layout.tsx decides with core/private-cases.ts handlesPrivateCases (a current handler grant, or a case it may
 * handle). Placement comes from the shared placement owner (lib/navigation-workspaces.ts). Presentation only: both
 * pages decide for themselves, and /cases shows each login only what row security returns. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';

vi.mock('next/navigation',()=>({usePathname:()=>'/me/cases/new',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()}),redirect:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));

import {Sidebar} from '../components/sidebar';
import {navigationPlacement,navigationRouteOwner} from '../lib/navigation-workspaces';

const rail=(role:{isAdmin:boolean;privateCaseHandler?:boolean})=>render(<NextIntlClientProvider locale="en" messages={messages}>
 <Sidebar isAdmin={role.isAdmin} canAdministerAi={role.isAdmin} enabledModules={['employees','leave']} privateCaseHandler={role.privateCaseHandler} defaultCollapsed={false}/>
</NextIntlClientProvider>);
const links=(href:string)=>[...document.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`)];
afterEach(cleanup);

describe('private case rows in the rail',()=>{
 it.each([
  ['an employee',{isAdmin:false},false],
  ['a designated handler without an administrator role',{isAdmin:false,privateCaseHandler:true},true],
  ['an HR administrator who handles no case',{isAdmin:true,privateCaseHandler:false},false],
  ['a group administrator who handles a fallback case',{isAdmin:true,privateCaseHandler:true},true],
 ] as const)('%s: "My private cases" always, "Private cases" only for a handler',(_who,role,handler)=>{
  rail(role);
  const mine=links('/me/cases');
  expect(mine.length).toBeGreaterThan(0);expect(mine[0].textContent).toContain(messages.nav.myPrivateCases);
  const queue=links('/cases');
  if(handler){expect(queue.length).toBeGreaterThan(0);expect(queue[0].textContent).toContain(messages.nav.privateCases);}
  else expect(queue).toHaveLength(0);
  // Discriminating, not blank: My workspace still renders beside them.
  expect(links('/me').length).toBeGreaterThan(0);
 });
 it('places both with My workspace, and each owns its own deep links',()=>{
  expect(navigationPlacement('/me/cases')).toEqual({area:'shared'});expect(navigationPlacement('/cases')).toEqual({area:'shared'});
  const rows=[{href:'/'},{href:'/me'},{href:'/me/cases'},{href:'/cases'}];
  expect(navigationRouteOwner('/me/cases/new','',rows)?.destination.href).toBe('/me/cases');
  expect(navigationRouteOwner('/me/cases/00000000-0000-4000-8000-0000000ca5e1','',rows)?.destination.href).toBe('/me/cases');
  expect(navigationRouteOwner('/cases/00000000-0000-4000-8000-0000000ca5e1','',rows)?.destination.href).toBe('/cases');
  expect(navigationRouteOwner('/me','',rows)?.destination.href).toBe('/me');
 });
 it('labels both in every shipped locale',async()=>{
  for(const locale of ['en','ms','zh','vi','ta','th']){
   const nav=(await import(`../messages/${locale}.json`)).default.nav as Record<string,string>;
   expect(nav.myPrivateCases?.trim(),locale).toBeTruthy();expect(nav.privateCases?.trim(),locale).toBeTruthy();
  }
 });
});
