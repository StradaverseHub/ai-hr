import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolveShellNavigation, type ShellNavigationFacts} from '../lib/navigation/shell-resolver';
import {SIDEBAR_AUDIENCE_INVENTORY, isCollapsible, type ChildItem} from '../lib/navigation/shell-inventory';
import {placeNavigation} from '../lib/navigation-workspaces';

const resolve = (facts: Partial<ShellNavigationFacts> = {}) => resolveShellNavigation({isAdmin:false, ...facts});
const hrefs = (facts: Partial<ShellNavigationFacts> = {}) => resolve(facts).destinations.map(row => row.href);
const inFamily = (facts: Partial<ShellNavigationFacts>, prefix:string) => hrefs(facts).filter(href => href.startsWith(prefix));

describe('shared shell policy preserves the pre-extraction visibility contract', () => {
  it('distinguishes unresolved entitlements from a resolved empty snapshot without hiding core rows', () => {
    expect(hrefs({enabledModules:null})).toContain('/claims');
    const empty = hrefs({enabledModules:[]});
    expect(empty).not.toContain('/claims');
    expect(empty).not.toContain('/attendance/clock');
    expect(empty).not.toContain('/assistant');
    // Exact independent expected order includes additional rows after the audience inventory.
    expect(empty).toEqual(['/', '/me', '/me/cases', '/org', '/leave', '/leave/history', '/leave/details',
      '/feedback', '/knowledge-base', '/tasks', '/personnel', '/leave/tracker']);
    expect(hrefs()).toEqual(hrefs({enabledModules:null}));
  });

  it('keeps a partner administration rail separate from actual AI administration and provider setup', () => {
    const partner = {isAdmin:true, assistantAccess:false, enabledModules:[]};
    expect(hrefs(partner)).toContain('/admin/organization');
    expect(hrefs(partner)).not.toContain('/assistant');
    const actual = resolve({...partner, canAdministerAi:true});
    expect(actual.destinations.map(row=>row.href)).toContain('/assistant');
    const sample = actual.destinations[0];
    expect(resolve(partner).canSeeChild({...sample, href:'/admin/ai'})).toBe(false);
    expect(actual.canSeeChild({...sample, href:'/admin/ai'})).toBe(true);
    expect(actual.canSeeChild({...sample, href:'/control-tower/agents/provider'})).toBe(false);
    expect(resolve({...partner,canConfigureAiProvider:true}).canSeeChild({...sample, href:'/control-tower/agents/provider'})).toBe(true);
  });

  it.each(['hasAssignedAttendanceApproval', 'hasAssignedApproval'] as const)('%s exposes only the assigned inbox', assignment => {
    const baseline = hrefs();
    const assigned = hrefs({[assignment]:true});
    expect(assigned.filter(href=>!baseline.includes(href))).toEqual(['/approvals']);
    expect(assigned).not.toContain('/manage/my-team');
    expect(assigned).not.toContain('/admin/organization');
    expect(assigned).not.toContain('/performance');
  });

  it('preserves independent security capabilities and the existing outer admin-group boundary', () => {
    const security = (facts:Partial<ShellNavigationFacts>) => hrefs(facts).filter(href => href.startsWith('/admin/users') || href.startsWith('/admin/security-center'));
    expect(security({isAdmin:true})).toEqual([]);
    expect(security({canConfigureAccess:true})).toEqual(['/admin/security-center','/admin/users/access']);
    expect(security({isAdmin:true,canAdministerSecurity:true})).toEqual(['/admin/security-center','/admin/users/function-access','/admin/users']);
    expect(security({isAdmin:true,canProvisionUsers:true})).toEqual(['/admin/users/create','/admin/users/invite']);
    expect(security({isAdmin:true,canConfigurePasswordPolicy:true})).toEqual(['/admin/security-center/password-policy']);
    // A provision-only/password-only capability did not itself open the legacy admin group.
    expect(security({canProvisionUsers:true,canConfigurePasswordPolicy:true})).toEqual([]);
    expect(security({canConfigureAccess:true,canProvisionUsers:true,canConfigurePasswordPolicy:true})).toEqual([
      '/admin/security-center','/admin/users/access','/admin/users/create','/admin/users/invite','/admin/security-center/password-policy',
    ]);
  });

  it('keeps the installation email operator limited to Email delivery', () => {
    const operator = hrefs({canConfigureIdentityEmail:true});
    expect(operator.filter(href=>href.startsWith('/admin/'))).toEqual(['/admin/settings/email']);
    expect(hrefs({isAdmin:true})).not.toContain('/admin/settings/email');
    expect(hrefs({isAdmin:true,canPreviewIdentityEmail:true})).toContain('/admin/settings/email');
    expect(hrefs({canPreviewIdentityEmail:true})).not.toContain('/admin/settings/email');
  });

  it('uses exact letter and rewards allowlists, entitlement checks, and declared order', () => {
    const facts = {letterDestinations:['/letters/register','/letters/templates','/letters/register/foreign'],
      rewardDestinations:['/admin/rewards/access','/rewards/analytics','/rewards/unknown']};
    expect(inFamily(facts,'/letters/')).toEqual(['/letters/templates','/letters/register']);
    expect(hrefs(facts).filter(href=>href.includes('rewards'))).toEqual(['/rewards/analytics','/admin/rewards/access']);
    expect(inFamily({...facts,enabledModules:[]},'/letters/')).toEqual([]);
    expect(hrefs({...facts,enabledModules:[]}).filter(href=>href.includes('rewards'))).toEqual([]);
    expect(inFamily({isAdmin:true},'/letters/')).toEqual([]);
    expect(hrefs({isAdmin:true}).filter(href=>href.includes('rewards'))).toEqual([]);
  });

  it('keeps V9 module flags separate from shared tasks and records', () => {
    const flags = {onboarding:false,offboarding:true,administration:false,records:false};
    expect(inFamily({onboardingV9Navigation:flags},'/lifecycle/v9')).toEqual([]);
    expect(inFamily({onboardingV9Access:true,onboardingV9Navigation:flags},'/lifecycle/v9')).toEqual([
      '/lifecycle/v9?view=leavers','/lifecycle/v9?view=offChecklists','/lifecycle/v9?view=tasks',
    ]);
    expect(inFamily({onboardingV9Access:true,onboardingV9Navigation:{...flags,records:true}},'/lifecycle/v9')).toEqual([
      '/lifecycle/v9?view=leavers','/lifecycle/v9?view=offChecklists','/lifecycle/v9?view=tasks','/lifecycle/v9?view=records',
    ]);
    expect(inFamily({onboardingV9Access:true},'/lifecycle/v9')).toEqual(['/lifecycle/v9?view=tasks']);
  });

  it('uses scoped lifecycle facts independently for page, configure, and intake', () => {
    const facts = {enabledModules:[],probationAccess:{page:true,configure:false},contractStaffAccess:{page:false,configure:false,intake:true}};
    expect(inFamily(facts,'/lifecycle/')).toEqual(['/lifecycle/probation','/lifecycle/contracts/intake']);
    expect(inFamily({probationAccess:{page:false,configure:true}},'/lifecycle/probation')).toEqual([
      '/lifecycle/probation/settings','/lifecycle/probation/forms','/lifecycle/probation/routes','/lifecycle/probation/workflows','/lifecycle/probation/templates','/lifecycle/probation/intake',
    ]);
    expect(inFamily({contractStaffAccess:{page:false,configure:true}},'/lifecycle/contracts')).toEqual([
      '/lifecycle/contracts/settings','/lifecycle/contracts/workflows','/lifecycle/contracts/templates',
    ]);
  });

  it('checks Performance entitlement at the declared address before substituting the cycle destination', () => {
    const latest = '/performance/fictional-cycle/cycle/calendar';
    expect(inFamily({canAdministerOnehr:true,enabledModules:[],performanceAdminHref:latest},'/performance')).toEqual([]);
    expect(inFamily({isAdmin:true,canApprove:true,enabledModules:['performance']},'/performance')).toEqual(['/performance/home']);
    const rows = resolve({canAdministerOnehr:true,enabledModules:['performance'],performanceAdminHref:latest}).destinations;
    expect(rows.filter(row=>row.href.startsWith('/performance')).map(row=>row.href)).toEqual(['/performance/home',latest]);
    expect(rows.find(row=>row.href===latest)?.ownedSubpaths).toContain('/performance');
    expect(inFamily({canAdministerOnehr:true,enabledModules:['performance']},'/performance')).toEqual(['/performance/home','/performance']);
  });

  it('replaces all legacy onboarding presentation even when its old capability flags are true', () => {
    const rows = hrefs({isAdmin:true,onboardingAccess:true,onboardingMaster:true,onboardingRequisitionsAccess:true});
    expect(rows.filter(href=>href.startsWith('/lifecycle/onboarding') || href.startsWith('/admin/lifecycle/onboarding') || href==='/lifecycle/requisitions/onboarding')).toEqual([]);
    expect(inFamily({onboardingV9Access:true,onboardingV9Navigation:{onboarding:true,offboarding:false,administration:false}},'/lifecycle/v9')).toEqual([
      '/lifecycle/v9','/lifecycle/v9?view=onbChecklists','/lifecycle/v9?view=tasks',
    ]);
  });

  it('preserves disabled destination identity and first-occurrence deduplication at the placement owner', () => {
    const home = SIDEBAR_AUDIENCE_INVENTORY[0];
    const first = home.items[0];
    if (isCollapsible(first)) throw new Error('fixture requires the Dashboard leaf');
    const disabled:ChildItem = {...first,href:'/locked-plan',labelKey:'development',disabled:true,exactHref:true,ownedSubpaths:['/locked-plan']};
    home.items.push(disabled);
    try {
      const rows = resolve().destinations;
      expect(rows.find(row=>row.href==='/locked-plan')).toBe(disabled);
      expect(rows.indexOf(disabled)).toBeLessThan(rows.findIndex(row=>row.href==='/tasks'));
      const placed = placeNavigation([...rows,{...first,labelKey:'duplicate'}]);
      expect(placed.placed.filter(row=>row.destination.href==='/')).toHaveLength(1);
      expect(placed.placed.find(row=>row.destination.href==='/')?.destination).toBe(first);
      expect(placed.unplaced).toContain(disabled);
    } finally { home.items.pop(); }
  });

  it('keeps render policy wired to this resolver, and disabled rows out of links, active ownership, and command entries', () => {
    const sidebar = readFileSync(new URL('../components/sidebar.tsx',import.meta.url),'utf8');
    expect(sidebar).toContain('const { destinations, lifecycleNavigation, canSeeChild } = resolveShellNavigation({');
    expect(sidebar).not.toContain('const moduleAllows');
    expect(sidebar).not.toContain('const canSeeChild');
    expect(sidebar).toContain('destinations.filter(row => !row.disabled)');
    expect(sidebar).toContain('.filter((c) => !c.disabled)');
    expect(sidebar).toContain('if (!r.disabled)');
    expect(sidebar.match(/if \(item.disabled\) return \(/g)).toHaveLength(3);
    expect(sidebar).toContain('aria-disabled="true"');
  });
});
