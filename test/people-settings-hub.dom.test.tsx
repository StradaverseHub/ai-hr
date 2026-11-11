/**
 * 82748f92 — People › Configuration › Settings, rendered: the menu row, its route ownership, the command-bar
 * aliases and the hub page's permission-filtered cards. Fictional sessions only; no database (the one General
 * fact is mocked at its owner, core/people-general.ts).
 */
import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {enWithAiCentre as messages} from './helpers/ai-centre-messages';
const nav=vi.hoisted(()=>({pathname:'/'}));
const redirect=vi.hoisted(()=>vi.fn((to:string)=>{throw new Error('NEXT_REDIRECT:'+to);}));
const people=vi.hoisted(()=>({session:{} as Record<string,unknown>,general:vi.fn(async()=>true)}));
vi.mock('next/navigation',()=>({usePathname:()=>nav.pathname,useSearchParams:()=>new URLSearchParams(),useRouter:()=>({push:vi.fn()}),redirect}));
vi.mock('../lib/session',()=>({getSession:vi.fn(async()=>people.session)}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
vi.mock('../core/people-general',()=>({canConfigurePeopleGeneral:people.general}));
vi.mock('../core/payroll-audit/reader-grant',()=>({hasAuditReaderGrant:vi.fn(async()=>false)}));
vi.mock('next-intl/server',async()=>{
  const {createTranslator}=await import('next-intl');
  return {getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages,namespace:namespace as never})};
});
import {Sidebar} from '../components/sidebar';
import {NavIndexProvider,useNavIndex} from '../components/nav-index-context';
import {PEOPLE_SETTINGS_SECTIONS,visiblePeopleSettingsSections} from '../lib/navigation/people-settings';
import {navigationRouteOwner} from '../lib/navigation-workspaces';
import {resolveShellNavigation} from '../lib/navigation/shell-resolver';
import PeopleSettingsPage from '../app/admin/settings/people/page';

const HUB='/admin/settings/people';
const SIX=['/admin/settings/employee-id','/admin/settings/people-general','/admin/settings/system-labels',
  '/admin/settings/movement','/admin/settings/hiring-defaults','/admin/settings/profile-requests'];
const LABELS=['employeeIdConfig','peopleGeneral','systemLabels','movementSettings','hiringDefaults','profileRequestSettings'] as const;

let published:{href:string;label:string}[]=[];
function IndexProbe(){const index=useNavIndex();React.useEffect(()=>{published=index.entries.map(e=>({href:e.href,label:e.label}));});return null;}
function rail(props:{isAdmin:boolean;canConfigurePeopleGeneral?:boolean}){
  return render(<NextIntlClientProvider locale="en" messages={messages} onError={error=>{throw error;}}>
    <NavIndexProvider><Sidebar isAdmin={props.isAdmin} canConfigurePeopleGeneral={props.canConfigurePeopleGeneral} enabledModules={null} defaultCollapsed={false}/><IndexProbe/></NavIndexProvider>
  </NextIntlClientProvider>);
}
beforeEach(()=>{nav.pathname='/';published=[];people.general.mockReset();people.general.mockResolvedValue(true);redirect.mockClear();});
afterEach(()=>{cleanup();});

describe('the six People setup rows become one Settings row',()=>{
  it('lists the six sections in today’s menu order, each an existing page with its existing nav label',async()=>{
    expect(PEOPLE_SETTINGS_SECTIONS.map(s=>s.href)).toEqual(SIX);
    expect(PEOPLE_SETTINGS_SECTIONS.map(s=>s.labelKey)).toEqual([...LABELS]);
    const fs=await import('node:fs');
    for(const href of SIX)expect(fs.existsSync(`app${href}/page.tsx`),href).toBe(true);
  });

  it('shows Organization then Settings under People › Configuration for an administrator, and none of the six rows',()=>{
    rail({isAdmin:true,canConfigurePeopleGeneral:true});
    fireEvent.click(screen.getByRole('button',{name:messages.nav.modulePeople}));
    const panel=screen.getByRole('navigation',{name:messages.nav.modulePeople});
    const links=within(panel).getAllByRole('link').map(a=>a.getAttribute('href'));
    const org=links.indexOf('/admin/organization');
    expect(org).toBeGreaterThan(-1);
    expect(links[org+1]).toBe(HUB);
    expect(within(panel).getByRole('link',{name:messages.nav.peopleSettings})).toHaveAttribute('href',HUB);
    for(const href of SIX)expect(links).not.toContain(href);
  });

  it('shows neither Organization nor Settings to an employee',()=>{
    rail({isAdmin:false});
    expect(screen.queryByRole('link',{name:messages.nav.peopleSettings})).toBeNull();
    expect(document.querySelector(`a[href="${HUB}"]`)).toBeNull();
    expect(published.some(e=>SIX.includes(e.href)||e.href===HUB)).toBe(false);
  });

  it('the Settings row owns every section and its sub-routes (menu highlight and breadcrumb)',()=>{
    const {destinations}=resolveShellNavigation({isAdmin:true,enabledModules:null} as never);
    for(const path of [...SIX,'/admin/settings/movement/reasons','/admin/settings/movement/types/new',
      '/admin/settings/hiring-defaults/00000000-0000-4000-8000-000000000001','/admin/settings/system-labels/profile-options',
      '/admin/settings/profile-requests/rules',HUB]){
      expect(navigationRouteOwner(path,'',destinations)?.destination.href,path).toBe(HUB);
    }
    expect(navigationRouteOwner('/admin/organization','',destinations)?.destination.href).toBe('/admin/organization');
  });

  it('the command bar still finds each section by its own name, and never offers General to a company-scoped administrator',()=>{
    rail({isAdmin:true,canConfigurePeopleGeneral:true});
    for(const [i,href] of SIX.entries())expect(published).toContainEqual({href,label:messages.nav[LABELS[i]]});
    expect(published.find(e=>e.label==='Movement Settings')?.href).toBe('/admin/settings/movement');
    cleanup();published=[];
    rail({isAdmin:true,canConfigurePeopleGeneral:false});
    expect(published.map(e=>e.href)).toContain('/admin/settings/movement');
    expect(published.map(e=>e.href)).not.toContain('/admin/settings/people-general');
    cleanup();published=[];
    rail({isAdmin:true}); // absent fact fails closed
    expect(published.map(e=>e.href)).not.toContain('/admin/settings/people-general');
  });
});

describe('the People Settings page shows only the sections the viewer may open',()=>{
  const admin={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',roles:['hr_admin']};
  const cardLinks=()=>screen.getAllByRole('link').map(a=>a.getAttribute('href'));
  it('a group administrator gets all six cards, in order, each opening its existing page',async()=>{
    people.session=admin;people.general.mockResolvedValue(true);
    render(await PeopleSettingsPage());
    expect(screen.getByRole('heading',{level:1,name:messages.peopleSettingsHub.title})).toBeInTheDocument();
    expect(cardLinks()).toEqual(SIX);
    expect(screen.getByRole('link',{name:messages.peopleSettingsHub.movement.cta})).toHaveAttribute('href','/admin/settings/movement');
    expect(people.general).toHaveBeenCalledTimes(1); // one fact for the whole page, never one per section
  });
  it('an administrator who cannot configure General does not see its card',async()=>{
    people.session=admin;people.general.mockResolvedValue(false);
    render(await PeopleSettingsPage());
    expect(cardLinks()).toEqual(SIX.filter(h=>h!=='/admin/settings/people-general'));
    expect(screen.queryByText(messages.peopleSettingsHub.general.title)).toBeNull();
  });
  it('a non-administrator is sent home before anything is read',async()=>{
    people.session={...admin,roles:['employee']};
    await expect(PeopleSettingsPage()).rejects.toThrow('NEXT_REDIRECT:/');
    expect(people.general).not.toHaveBeenCalled();
  });
  it('the pure filter mirrors the page guards',()=>{
    expect(visiblePeopleSettingsSections({isAdmin:false,canConfigurePeopleGeneral:true})).toEqual([]);
    expect(visiblePeopleSettingsSections({isAdmin:true,canConfigurePeopleGeneral:false}).map(s=>s.key))
      .toEqual(['employeeId','systemLabels','movement','hiringDefaults','changeRequests']);
  });
});

describe('each section page links Back to Settings',()=>{
  it('the eight listing pages pass the shared back link and mount the unsaved-changes check',async()=>{
    const fs=await import('node:fs');
    for(const page of ['employee-id','people-general','system-labels','system-labels/profile-options','movement','movement/reasons','hiring-defaults','profile-requests']){
      const src=fs.readFileSync(`app/admin/settings/${page}/page.tsx`,'utf8');
      expect(src,page).toMatch(/<PageHeader[^>]*back=\{await peopleSettingsBack\(\)\}/);
      expect(src,page).toContain('<PeopleSettingsNavigation />');
    }
    // The company page keeps its own link back to the Hiring Defaults list, and is still guarded.
    const detail=fs.readFileSync('app/admin/settings/hiring-defaults/[companyId]/page.tsx','utf8');
    expect(detail).toContain("back={{ href: PAGE, label: t('title') }}");
    expect(detail).toContain('<PeopleSettingsNavigation />');
    const {peopleSettingsBack}=await import('../app/admin/settings/people/back');
    expect(await peopleSettingsBack()).toEqual({href:HUB,label:'Back to Settings'});
  });
});
