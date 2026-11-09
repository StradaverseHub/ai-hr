/** Pure presentation policy over server-resolved capabilities; never grants page/service access. */
import { modulePackById } from '@/packs/registry';
import { navigationPlacement } from '@/lib/navigation-workspaces';
import { isSecurityDestination, securityDestinationAllowed } from '@/lib/security-center-navigation';
import { V9_NAVIGATION, V9_SHARED_NAVIGATION, type V9NavigationPermissions } from '@/lib/lifecycle-v9-navigation';
import {
  ADDITIONAL_ROWS, AI_PROVIDER_HREF, GROUPS, MODULE_OF_HREF, MY_TEAM_ROW, ONBOARDING_NODE,
  PERFORMANCE_ADMIN_ROW, SCOPED_LIFECYCLE_NAVIGATION, isAiAdministrationHref, isCollapsible, type ChildItem,
} from './shell-inventory';

/** Existing shell facts, already resolved by their server capability owners. */
export type ShellNavigationFacts = {
  isAdmin: boolean;
  canAdministerSecurity?: boolean;
  canConfigureAccess?: boolean;
  canProvisionUsers?: boolean;
  canConfigureIdentityEmail?: boolean;
  canConfigureLoginPresentation?: boolean;
  canConfigurePasswordPolicy?: boolean;
  /** Actual HR administrator access, independent of the broader partner administration rail. */
  canPreviewIdentityEmail?: boolean;
  /** Manager-and-up: shows the Approvals inbox. */
  canApprove?: boolean;
  /** A pending request-bound assignment exposes only the inbox, never manager navigation. */
  hasAssignedAttendanceApproval?: boolean;
  /** Actual canonical inbox assignment. Exposes this destination, never manager navigation. */
  hasAssignedApproval?: boolean;
  /** Actual HR administration, independent of the broader partner administration rail. */
  canReviewProfileChanges?: boolean;
  /** Actual HR administration: the Control Tower and AI configuration run requireAdmin, so the
   * broader partner administration rail must not list them. */
  canAdministerAi?: boolean;
  /** Group-wide administration: a company administrator is sent from Provider back to the AI Overview. */
  canConfigureAiProvider?: boolean;
  /** Actual My Team role authority, independent of the broader partner administration rail. */
  canAccessTeam?: boolean;
  letterDestinations?: readonly string[];
  rewardDestinations?: readonly string[];
  /**
   * ADR-0142 — OneHR performance administration (admins, perf-comp partners, OneHR performance partners).
   * The ONLY gate of the Performance admin entry (D-P1-32 PT-X5); it never opens the admin rail, approvals or My Team.
   */
  canAdministerOnehr?: boolean;
  /**
   * D-P1-32 PT-X5 — where Performance admin opens: the admin area's first tab for the latest cycle the viewer
   * administers (app/layout.tsx). Absent means the pack's own address, /performance (no cycle yet).
   */
  performanceAdminHref?: string;
  /**
   * ADR-0077 slice 4 — module codes whose rows may be shown. `null` means "no opinion, show
   * everything", which is NOT the same as `[]` ("show nothing"): a session whose entitlement snapshot
   * failed to resolve passes null on purpose, so an infrastructure blip degrades to the pre-slice-4
   * rail rather than emptying the menu of a paying customer. Hiding is cosmetic either way — every
   * page these rows point at refuses on its own (D3).
   */
  enabledModules?: string[] | null;
  /** 28 Oct 2026 (owner): the Assistant row is offered only to a login that may use the Assistant (module,
   * grant). app/layout.tsx computes it and passes false on any failure. Own-data controls stay reachable from
   * My workspace, and /assistant itself still refuses and explains on its own. */
  assistantAccess?: boolean;
  /** 0696 — false when an operator has hidden the Feedback menu for this customer. /feedback refuses on its own. */
  feedbackAccess?: boolean;
  /** AI v2 W11 — the login handles private cases (a current handler grant, or a case it may handle). Only then is the
   * "Private cases" queue row offered; /cases still shows each login only what row security returns. */
  privateCaseHandler?: boolean;
  probationAccess?: {page:boolean;configure:boolean;intake?:boolean};
  contractStaffAccess?: {page:boolean;configure:boolean;intake?:boolean};
  onboardingAccess?: boolean;
  onboardingV9Access?: boolean;
  onboardingV9Navigation?: V9NavigationPermissions;
  onboardingMaster?: boolean;
  onboardingRequisitionsAccess?: boolean;
};

export type ShellNavigationResolution = {
  destinations: ChildItem[];
  lifecycleNavigation: ChildItem[];
  canSeeChild: (row: ChildItem) => boolean;
};

export function resolveShellNavigation({
  isAdmin,
  canConfigureIdentityEmail = false,
  canConfigureLoginPresentation = false,
  canConfigurePasswordPolicy = false,
  canPreviewIdentityEmail = false,
  canApprove = false,
  hasAssignedAttendanceApproval = false,
  hasAssignedApproval = false,
  canReviewProfileChanges = false,
  canAdministerAi = false,
  canAdministerSecurity = false,
  canConfigureAccess = false,
  canProvisionUsers = false,
  canConfigureAiProvider = false,
  canAccessTeam = false,
  letterDestinations = [],
  rewardDestinations = [],
  canAdministerOnehr = false,
  performanceAdminHref,
  probationAccess = {page:false,configure:false},
  contractStaffAccess = {page:false,configure:false},
  onboardingAccess = false,
  onboardingV9Access = false,
  onboardingV9Navigation,
  onboardingMaster = false,
  onboardingRequisitionsAccess = false,
  enabledModules = null,
  assistantAccess = true,
  feedbackAccess = true,
  privateCaseHandler = false,
}: ShellNavigationFacts): ShellNavigationResolution {
  /**
   * Is this row's owning module on the tenant's plan? (ADR-0077 slice 4.)
   *
   * `enabledModules === null` means the session could not resolve a snapshot, so the rail expresses no
   * opinion and shows everything — see lib/nav-entitlements.ts for why nav fails open where services
   * fail closed. A row belonging to no sellable module (core rows, hardcoded rows) is always shown.
   */
  const moduleAllows = (href: string) => {
    if (enabledModules === null) return true;
    const owner = MODULE_OF_HREF.get(href);
    return owner == null || enabledModules.includes(owner);
  };
  // Per-child visibility for flyout nodes (per-child gating vs. whole-group gating). Role gating and
  // module gating are ANDed: a row needs both the role AND the module to appear.
  const securityAccess={admin:canAdministerSecurity,configure:canConfigureAccess,provision:canProvisionUsers,passwordPolicy:canConfigurePasswordPolicy};
  // Issue 17: the AI Centre row is also the only way to Operations and Administration, so an actual HR
  // administrator (whose requireAdmin pages those are) keeps it without the Assistant grant or module; /assistant
  // then shows its unavailable home with the centre's tabs, and every page still checks for itself.
  const canSeeChild = (c: ChildItem) => (c.href === '/assistant' && canAdministerAi) ||
    (!isSecurityDestination(c.href)||securityDestinationAllowed(c.href,securityAccess)) && moduleAllows(c.href) && (c.href !== '/lifecycle/v9'||onboardingV9Access) && (c.href !== '/assistant' || assistantAccess) && (c.href !== '/feedback' || feedbackAccess) && (c.href !== '/cases' || privateCaseHandler) && (!c.href.startsWith('/letters/')||letterDestinations.includes(c.href)) && (!c.href.startsWith('/lifecycle/onboarding')||onboardingAccess) && (c.href!=='/lifecycle/requisitions/onboarding'||onboardingRequisitionsAccess) && (c.href!=='/admin/lifecycle/onboarding'||onboardingAccess) && (c.href!=='/admin/lifecycle/onboarding/groups'||onboardingAccess||onboardingMaster) && (c.href!=='/admin/lifecycle/onboarding/access'||onboardingMaster) && (c.loginPresentationOnly ? canConfigureLoginPresentation : c.identityEmailOnly ? canPreviewIdentityEmail || canConfigureIdentityEmail : c.href === MY_TEAM_ROW.href ? canAccessTeam : c.href === PERFORMANCE_ADMIN_ROW.href ? canAdministerOnehr : c.href === '/admin/personnel/profile-changes' ? canReviewProfileChanges : c.href === AI_PROVIDER_HREF ? canConfigureAiProvider : isAiAdministrationHref(c.href) ? canAdministerAi : c.adminOnly ? isAdmin : c.managerUp ? isAdmin || canApprove || c.href === '/approvals' && (hasAssignedAttendanceApproval||hasAssignedApproval) : true);
  // The former audience inventory still supplies its original visibility boundaries.
  // Only authorized rows are handed to the workspace placement owner below.
  const authorizedGroups = GROUPS
    // Group-level flags still supported (the Admin group uses adminOnly).
    .filter((g) => (g.adminOnly ? isAdmin || canConfigureAccess || canConfigureIdentityEmail || onboardingAccess || onboardingMaster : g.managerUp ? isAdmin || canApprove : true))
    // 1b35f17b: filter per-row too, so a group (e.g. Manage) can mix all-employee rows
    // (Personnel) with manager-up rows (Approvals/Performance).
    .map((g) => ({
      ...g,
      items: g.items.filter((r) => (!g.adminOnly || isAdmin || (!isCollapsible(r)&&isSecurityDestination(r.href)&&canSeeChild(r)) || (!isCollapsible(r)&&r.href.startsWith('/admin/lifecycle/onboarding')&&canSeeChild(r)) || (isCollapsible(r) ? r.children.some(c => c.identityEmailOnly && canSeeChild(c)) : r.identityEmailOnly)) && (isCollapsible(r) ? r.children.some(canSeeChild) : canSeeChild(r))),
    }))
    // Drop a group that has become empty for this viewer (no stray divider in the collapsed rail).
    .filter((g) => g.items.length > 0);

  const authorizedRows = authorizedGroups.flatMap(group => group.items.flatMap(row =>
    isCollapsible(row) ? row.children.filter(canSeeChild) : [row],
  )).filter(row => row.href !== '/mobile-preview' || isAdmin)
    // Gated on the pack's address above; only then pointed at the latest cycle's admin area. It keeps owning every
    // other /performance route through its ownedSubpaths, so the cycle pages and admin tabs light it.
    .map(row => row === PERFORMANCE_ADMIN_ROW && performanceAdminHref ? {...row, href: performanceAdminHref} : row);
  // The old lifecycle addresses remain valid for existing records and links, but their old
  // hub/self-service/requisition presentation is replaced by the owner's explicit V9 hierarchy.
  const lifecycleNavigation: ChildItem[] = V9_NAVIGATION.filter(item => onboardingV9Access &&
    !!onboardingV9Navigation?.[item.permission]).map(item => ({
      href: item.href, labelKey: item.labelKey, submenuKey: item.submenuKey, icon: ONBOARDING_NODE.icon,
      exactHref: true, ...('ownedSubpaths' in item ? { ownedSubpaths: [...item.ownedSubpaths] } : {}),
    } satisfies ChildItem)).filter(canSeeChild);
  const lifecycleShared: ChildItem[] = V9_SHARED_NAVIGATION.filter(item => onboardingV9Access &&
    (item.view === 'tasks' || !!onboardingV9Navigation?.records)).map(item => ({href:item.href,labelKey:item.labelKey,icon:ONBOARDING_NODE.icon,exactHref:true})).filter(canSeeChild);
  // New module owners resolve both the actual purchased company and business-role visibility.
  // These additive People destinations do not inherit the legacy global-only Lifecycle nav gate.
  const scopedLifecycleRows = SCOPED_LIFECYCLE_NAVIGATION.filter(item => {
    const access = item.module === 'probation' ? probationAccess : contractStaffAccess;
    switch (item.access) {
      case 'page': return access.page;
      case 'configure': return access.configure;
      case 'configureOrIntake': return access.configure || access.intake === true;
      case 'intake': return access.intake === true;
    }
  });
  const rewardRows = modulePackById('rewards')!.navLinks!
    .filter(row => rewardDestinations.includes(row.href) && moduleAllows(row.href));
  const destinations: ChildItem[] = [...authorizedRows.filter(row => {
    const placement = navigationPlacement(row.href);
    return !placement || !('module' in placement) || placement.module !== 'onboarding';
  }), ...ADDITIONAL_ROWS.filter(canSeeChild), ...lifecycleNavigation, ...lifecycleShared, ...scopedLifecycleRows, ...rewardRows];
  return { destinations, lifecycleNavigation, canSeeChild };
}
