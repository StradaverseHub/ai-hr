'use client';

import Link from './intent-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useIsMonolith, useUiTheme } from './ui-theme-context';
import {
  Command,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Lock,
  Settings2,
  ShieldCheck,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApprovalCountBadge } from '@/components/approval-count-badge';
import {
  NavFlyout,
  NavFlyoutPanel,
  isHrefActive,
  isNavRowActive,
  isParentActive,
  type FlyoutChild,
} from '@/components/nav-flyout';
// ADR-0080 rungs 2-7: every module pack's nav mounts from the pack registry, so the packs must be
// REGISTERED before this module's body runs. The five side-effect imports that used to sit here moved
// to packs/register-all.ts — unchanged in effect, but reachable from server code too. They lived in a
// client component, which meant any caller of listPacks('module') outside the client bundle silently
// got an empty array; today that caller is the catalog<->registry drift ratchet (ADR-0077), and slice
// 4's nav filter is next. Each pack index stays client-safe by design, so this import pulls no
// server-only code into the bundle. See that file's header.
import '@/packs/register-all';
import { NAVIGATION_MODULES, NAVIGATION_SECTIONS, placeNavigation, navigationPlacement, navigationRouteOwner, type NavigationWorkspace } from '@/lib/navigation-workspaces';
import { usePublishNavIndex, type NavIndexEntry } from '@/components/nav-index-context';
import {useShellApprovalFacts} from '@/components/shell-approval-facts';
import {isSecurityDestination} from '@/lib/security-center-navigation';
import { openCommandBar } from '@/lib/command-bar-events';
import { V9_SHARED_NAVIGATION } from '@/lib/lifecycle-v9-navigation';
import { NavigationSubmenus } from '@/components/navigation-submenus';

import { isCollapsible, type ChildItem, type CollapsibleGroupItem, type Row, type Group } from '@/lib/navigation/shell-inventory';
import { resolveShellNavigation, type ShellNavigationFacts } from '@/lib/navigation/shell-resolver';
export { SIDEBAR_AUDIENCE_INVENTORY } from '@/lib/navigation/shell-inventory';

const REVIEW_WORKSPACE_PATH = '/performance/workspace';

/** Detached rail that floats on the canvas. Collapses to an icon-only strip; expands
 *  to icon + label. The choice persists via the `rail_collapsed` cookie (read SSR-side
 *  in the layout, so there's no flash and no hydration mismatch). Modules with sub-items
 *  (fdc20776) open a flyout panel BESIDE the rail instead of expanding in place, so the
 *  rail keeps a constant height however many sub-items exist. */
export function Sidebar({
  isAdmin,
  canConfigureIdentityEmail = false,
  canConfigureLoginPresentation = false,
  canConfigurePasswordPolicy = false,
  canPreviewIdentityEmail = false,
  canApprove = false,
  hasAssignedAttendanceApproval:assignedAttendanceFromProps = false,
  hasAssignedApproval:assignedApprovalFromProps = false,
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
  approvalCount:baseApprovalCount = 0,
  taskCount:baseTaskCount = 0,
  probationAccess = {page:false,configure:false},
  contractStaffAccess = {page:false,configure:false},
  onboardingAccess = false,
  onboardingV9Access = false,
  onboardingV9Navigation,
  onboardingMaster = false,
  onboardingRequisitionsAccess = false,
  onboardingJoinerCount,
  onboardingChecklistCount,
  enabledModules = null,
  assistantAccess = true,
  feedbackAccess = true,
  privateCaseHandler = false,
  defaultCollapsed,
  viewerName = null,
  viewerCode = null,
}: ShellNavigationFacts & {
  /** Pending items awaiting THIS viewer's decision (feedback 836118c4) — badge on the
   *  "Approval Items" row. Computed once in app/layout.tsx as listPendingTasks(...).length; the rail
   *  never queries. 0 (or a viewer without the row) renders no badge. */
  approvalCount?: number;
  taskCount?: number;
  onboardingJoinerCount?:number;
  onboardingChecklistCount?:number;
  defaultCollapsed: boolean;
  /** r398 — the Monolith rail's user line (README §3). Display only; Classic does not render it. */
  viewerName?: string | null;
  viewerCode?: string | null;
}) {
  const approvals=useShellApprovalFacts()?.result;
  const hasAssignedAttendanceApproval=approvals?approvals.state==='ready'&&approvals.hasAssignedAttendanceApproval:assignedAttendanceFromProps;
  const hasAssignedApproval=approvals?approvals.state==='ready'&&approvals.hasAssignedApproval:assignedApprovalFromProps;
  const approvalCount=approvals?approvals.state==='ready'?approvals.approvalCount:0:baseApprovalCount;
  const taskCount=approvals?approvals.state==='ready'?baseTaskCount+approvals.total:0:baseTaskCount;
  const pathname = usePathname();
  // Query-aware active matching (fdc20776): usePathname excludes the query string, so the six
  // Reports children (/reports?cat=…) need the search params to light up. Safe without a Suspense
  // boundary here: the root layout awaits cookies()/headers(), so every route is dynamically
  // rendered (see node_modules/next/dist/docs — the boundary is only mandatory on static pages).
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const tNav = useTranslations('nav');
  // Every row, AI Centre included, reads its own translated nav label (owner, 3 November 2026: the product name
  // appears only on How it works).
  const t = tNav;
  const tWorkspace = useTranslations('onehr.workspace');
  // `common`, NOT `nav`: the brand name lives at common.appName. Reading it off `t` would resolve
  // nav.appName, which does not exist — and a MISSING_MESSAGE passes tsc, the suite and `next build`
  // alike, so nothing would have told us until the screen rendered.
  const tCommon = useTranslations('common');
  const [collapsedPref, setCollapsed] = useState(defaultCollapsed);
  // r398 — Monolith's rail is always open on desktop (README §3: "the boards assume the rail is always open
  // on desktop"), so it offers no collapse and ignores the preference. Classic reads it exactly as before;
  // the `rail_collapsed` cookie is neither read differently nor written by Monolith.
  const monolith = useIsMonolith();
  const [workspaceChoice, setWorkspaceChoice] = useState<NavigationWorkspace | null>(null);
  const atelier = useUiTheme() === 'atelier';
  const tBar = useTranslations('commandBar');
  const locale = useLocale();
  // r398 — Monolith shows a module's children INLINE (no flyout panel). An explicit open/close per module
  // overrides "open while you are inside it"; the default is the active module open, every other closed.
  const [railKids, setRailKids] = useState<Readonly<Record<string, boolean>>>({});
  // Single-open flyout state (fdc20776): the labelKey of the open module, or null. Clicking a
  // parent sets it (replacing any other open module); clicking the same parent again closes.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mobileNavigationTrigger = useRef<HTMLButtonElement | null>(null);
  // D-P1-28 — Classic's phone drawer shows the rail with its labels whatever the desktop collapse preference is
  // (an icon strip is no menu on a phone). Atelier's own phone navigation keeps its rules.
  const collapsed = monolith ? false : collapsedPref && !(mobileNavigationOpen && !atelier);
  /**
   * WHICH SECTIONS ARE EXPANDED — the fix for a rail that did not fit.
   *
   * MEASURED BEFORE THIS EXISTED (production build, 1440x900): the rail's content was 1490px in a 746px
   * column on EVERY screen. 34 entries, 16 reachable without scrolling, 18 below the fold — including
   * Analytics, Audit trail, Data Privacy, Security & permissions and AI, which is where a provider is
   * configured. A menu whose second half is only reachable by scrolling is not a menu people use.
   *
   * Route ownership opens the current section by default. An explicit user choice can still close it;
   * navigating to another route opens that route's section again without changing current-link matching.
   *
   * Session state, deliberately NOT a cookie. `rail_collapsed` is read SSR-side precisely so the icon
   * rail has no flash; a second cookie read on the client after mount would flip sections open after
   * paint, which is the same flash in a new place. Navigating within a section keeps it open, and moving
   * to another section opens that one, so the state a user actually experiences is the useful one.
   */
  const [inlineOpen, setInlineOpen] = useState<Record<string, boolean>>({});
  const [openSections, setOpenSections] = useState<Readonly<Record<string, boolean>>>({});
  // Escape returns focus to the trigger that opened the panel.
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingTriggerFocus = useRef<string | null>(null);
  useEffect(() => {
    if (openKey === null && pendingTriggerFocus.current) {
      triggerRefs.current[pendingTriggerFocus.current]?.focus();
      pendingTriggerFocus.current = null;
    }
  }, [openKey]);
  // Safety net for back/forward navigation only — picking a sub-item closes via its onClick
  // (mandatory: the Reports children share one pathname and differ only in the query, so this
  // effect never fires when switching report categories).
  useEffect(() => {
    setOpenKey(null);
    setMobileNavigationOpen(false);
    setInlineOpen({});
    setRailKids({});
    setWorkspaceChoice(null);
  }, [pathname, search]);
  const { destinations, lifecycleNavigation, canSeeChild } = resolveShellNavigation({
    isAdmin, canConfigureIdentityEmail, canConfigureLoginPresentation, canConfigurePasswordPolicy, canPreviewIdentityEmail, canApprove, hasAssignedAttendanceApproval, hasAssignedApproval, canReviewProfileChanges, canAdministerAi, canAdministerSecurity, canConfigureAccess, canProvisionUsers, canConfigureAiProvider, canAccessTeam, letterDestinations, rewardDestinations, canAdministerOnehr, performanceAdminHref, probationAccess, contractStaffAccess, onboardingAccess, onboardingV9Access, onboardingV9Navigation, onboardingMaster, onboardingRequisitionsAccess, enabledModules, assistantAccess, feedbackAccess, privateCaseHandler,
  });
  const navigation = placeNavigation(destinations);
  const availableWorkspaces = (['ops','strata'] as const).filter(workspace =>
    navigation.placed.some(row => row.placement.area === workspace),
  );
  const routeOwner = navigationRouteOwner(pathname, search, destinations.filter(row => !row.disabled));
  const routeWorkspace = routeOwner?.placement.area;
  const selectedWorkspace = workspaceChoice && availableWorkspaces.includes(workspaceChoice) ? workspaceChoice
    : routeWorkspace === 'ops' || routeWorkspace === 'strata' ? routeWorkspace : availableWorkspaces[0];
  const moduleRows: Row[] = NAVIGATION_MODULES.filter(module => module.workspace === selectedWorkspace).flatMap<Row>(module => {
    const children = NAVIGATION_SECTIONS.flatMap(section => navigation.placed.filter(row =>
      'module' in row.placement && row.placement.module === module.id && row.placement.section === section,
    ).map(row => row.destination));
    if (!children.length) return [];
    if (children.length === 1 && !['onboarding','probation','contracts','rewards'].includes(module.id)) return [{...children[0],labelKey:module.labelKey}];
    return [{collapsible:true,activeMatch:'children',labelKey:module.labelKey,icon:children[0].icon,
      children,tour:children.some(child=>child.tour==='nav-admin')?'nav-admin':undefined} satisfies CollapsibleGroupItem];
  });
  const sharedRows = navigation.placed.filter(row=>row.placement.area==='shared').map(row=>row.destination);
  const inboxRows = sharedRows.filter(row=>['/tasks','/approvals','/system-testing',...V9_SHARED_NAVIGATION.map(item=>item.href)].includes(row.href));
  const sharedItems: Row[] = sharedRows.filter(row=>!inboxRows.includes(row));
  if (inboxRows.length) sharedItems.splice(Math.min(2,sharedItems.length),0,{
    collapsible:true,activeMatch:'children',labelKey:'inbox',icon:ListChecks,children:inboxRows,
    tour:inboxRows.some(row=>row.tour==='nav-approvals')?'nav-approvals':undefined,
  });
  const systemRows = navigation.placed.filter(row=>row.placement.area==='system').map(row=>row.destination);
  const securityRows=systemRows.filter(row=>isSecurityDestination(row.href));
  const otherSystemRows=systemRows.filter(row=>!isSecurityDestination(row.href));
  const groups: Group[] = [
    {items:[...sharedItems,...navigation.unplaced]},
    {labelKey:selectedWorkspace==='strata'?'workspaceStrata':'workspaceOps',items:moduleRows},
    ...(systemRows.length ? [{labelKey:'systemConfiguration',items:[
      ...(otherSystemRows.length?[{collapsible:true,activeMatch:'children',labelKey:'systemConfiguration',icon:Settings2,children:otherSystemRows} satisfies CollapsibleGroupItem]:[]),
      ...(securityRows.length?[{collapsible:true,activeMatch:'children',labelKey:'securityCenter',icon:ShieldCheck,children:securityRows} satisfies CollapsibleGroupItem]:[]),
    ]}] : []),
  ];
  const isWorkspaceKey = (key?:string) => key==='workspaceOps'||key==='workspaceStrata';
  const compactWorkspace = collapsed && !atelier && !monolith;
  const workspaceSwitch = () => availableWorkspaces.length > 1 ? <div role="group" aria-label={t('workspaceSwitch')}
    className={cn('flex gap-1 rounded-lg border border-border p-1',compactWorkspace&&'flex-col')}>
    {availableWorkspaces.map(workspace=><button key={workspace} type="button" aria-pressed={selectedWorkspace===workspace}
      onClick={()=>{setWorkspaceChoice(workspace);setOpenKey(null);setInlineOpen({});setRailKids({});}}
      className={cn('min-h-11 flex-1 rounded-md font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',compactWorkspace?'px-1 text-xs':'px-2 text-sm',selectedWorkspace===workspace?'bg-accent text-accent-foreground':'text-muted-foreground hover:bg-accent/60')}>
      {t(workspace==='ops'?'workspaceOps':'workspaceStrata')}
    </button>)}
  </div> : null;
  const sectionLabel = (href:string) => {
    const lifecycle = lifecycleNavigation.find(item => item.href === href);
    if (lifecycle) return lifecycle.submenuKey;
    const placement=navigationPlacement(href);
    if (placement && 'module' in placement && placement.module === 'rewards' && placement.section === 'mine') return 'sectionManagingRewards';
    if (placement && 'module' in placement && ['probation','contracts'].includes(placement.module) && placement.section === 'hr') return undefined;
    return placement && 'section' in placement ? `section${placement.section==='hr'?'HR':placement.section==='ai'?'AiManagement':placement.section==='config'?'Configuration':placement.section==='mine'?'Mine':'Team'}` : undefined;
  };

  const childCaption=(child:{href:string;labelKey:string})=>{
    const count=child.href==='/lifecycle/onboarding'||child.href==='/lifecycle/v9'?onboardingJoinerCount:child.href==='/lifecycle/onboarding/checklists'||child.href==='/lifecycle/v9?view=onbChecklists'?onboardingChecklistCount:undefined;
    const pending=child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0;
    return <>{t(child.labelKey)}{count!==undefined&&<span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{count}</span>}{pending>0&&<><span className="sr-only">{`, ${t('approvalsCount',{count:pending})}`}</span><ApprovalCountBadge count={pending} collapsed={false}/></>}</>;
  };
  const isActive = (href: string) => isHrefActive(pathname, search, href);
  // The shared route owner preserves query intent and explicit owned subpaths across all themes.
  const isRowActive = (r: { href: string; exactHref?: boolean; ownedSubpaths?: string[]; disabled?: boolean }) => {
    if(r.disabled)return false;
    // One owner across shared rows and modules, including query-based and non-descendant routes.
    if(routeOwner)return r.href===routeOwner.destination.href;
    return isNavRowActive(pathname,search,r);
  };
  // 10b59703 — the paths a fly-out child answers for: its own href plus any `ownedSubpaths` the pack
  // declared (packs/registry.ts NavChildDescriptor). Fed to isParentActive so the parent node lights
  // up on an owned tab exactly as it does on the child's own address. Highlighting only, never a gate.
  const childPaths = (c: { href: string; ownedSubpaths?: string[] }) => [c.href, ...(c.ownedSubpaths ?? [])];
  // The open module's node (permission-filtered children), resolved from the visible groups so a
  // stale openKey (e.g. after a role change) simply renders no panel.
  /** The section containing the current page — from the same predicates the rows light up with, so the
   *  open section and the highlighted row can never disagree. */
  const activeSectionKey =
    groups.find((g) =>
      g.items.some((r) =>
        isCollapsible(r)
          ? (r.defaultHref || r.activeMatch === 'children' ? r.children.filter(canSeeChild).some(isRowActive) : isParentActive(pathname, r.children.filter(canSeeChild).flatMap(childPaths)))
          : isRowActive(r),
      ),
    )?.labelKey ?? null;

  // Reset only the destination section's manual override on actual navigation (including report
  // categories sharing a pathname). A same-route rerender must retain an explicit collapse.
  useEffect(() => {
    if (!activeSectionKey) return;
    setOpenSections((prev) => {
      if (!(activeSectionKey in prev)) return prev;
      const next = { ...prev };
      delete next[activeSectionKey];
      return next;
    });
  }, [pathname, search, activeSectionKey]);
  const sectionOpen = (key?: string) =>
    key == null || isWorkspaceKey(key) || (openSections[key] ?? key === activeSectionKey);
  const toggleSection = (key: string) => setOpenSections((prev) => ({
    ...prev, [key]: !(prev[key] ?? key === activeSectionKey),
  }));

  /* Atelier round 1 — publish what this rail shows, for the command bar's "Go to" list and the Atelier
     breadcrumb (components/nav-index-context.tsx). Built from the SAME filtered `groups` and the same
     `canSeeChild` / `isRowActive` the rows render with, in every theme, so the palette can never list a
     destination this viewer's rail hides. Called before any early return: it is a hook. */
  const navEntries: NavIndexEntry[] = [];
  let activeEntry: NavIndexEntry | null = null;
  for (const g of groups) {
    const section = g.labelKey ? t(g.labelKey) : null;
    for (const r of g.items) {
      if (isCollapsible(r)) {
        const kids = r.children.filter(canSeeChild).filter((c) => !c.disabled);
        const parent = t(r.labelKey);
        const parentHref = r.defaultHref ?? (kids[0] ? kids[0].navigationHref ?? kids[0].href : null);
        const activeKid = kids.filter((c) => isRowActive(c))
          .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0];
        for (const c of kids) {
          const entry = { href: c.navigationHref ?? c.href, label: t(c.labelKey), section, parent, parentHref };
          navEntries.push(entry);
          if (!activeEntry && c === activeKid) activeEntry = entry;
        }
      } else if (!r.disabled) {
        const entry = { href: r.navigationHref ?? r.href, label: t(r.labelKey), section, parent: null, parentHref: null };
        navEntries.push(entry);
        if (!activeEntry && isRowActive(r)) activeEntry = entry;
      }
    }
  }
  usePublishNavIndex(navEntries, activeEntry);

  const openNode = openKey && (!monolith || openKey === 'securityCenter')
    ? groups.flatMap((g) => g.items).find((r): r is CollapsibleGroupItem => isCollapsible(r) && r.labelKey === openKey && (atelier || !r.defaultHref || collapsed)) ?? null
    : null;
  const openChildren = openNode ? openNode.children.filter(canSeeChild) : [];
  // Inside a panel the LONGEST matching href wins, so exactly one row ever reads as the current page
  // (1459e116 requirement 3). isHrefActive matches a path prefix, which is what makes a parent row a
  // valid nav target at all — but it also means Payroll's "Payroll Process" (/payroll) matches while
  // the viewer is on /payroll/setup, lighting it up next to "Settings". Ranking by path length picks
  // the more specific row; the rail's own parent highlighting (isParentActive) is unaffected.
  const activeChildHref = openChildren
    // 10b59703 — a child that OWNS paths outside its own href (Entitlements owns the Entitlement tables
    // and Configuration record tabs; Leave Adjustments owns Balance record and Import) is active on
    // them too, through the same predicate the flat rows use.
    .filter((c) => isRowActive(c))
    .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      document.cookie = `rail_collapsed=${next ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });

  const rowBase =
    'group flex items-center rounded-2xl transition duration-150 ease-snappy active:scale-[0.98]';

  /* ── r398 — THE MONOLITH RAIL (README §3, shell.css `.rail`). Rendering only: it walks the SAME `groups`
     (already role- and module-filtered above), the same `canSeeChild`, and lights rows with the same
     isNavRowActive / isParentActive predicates, so which rows exist, in which order, and which one is
     current cannot differ between the themes. What differs is structure the board needs and CSS cannot
     produce: no icons, mono rows, and a module's children INLINE behind a hairline instead of a flyout. */
  const railRow =
    'flex min-h-8 w-full items-center justify-between gap-2 border-l border-transparent py-1 pl-2.5 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-mid no-underline hover:border-hairline hover:text-ink';
  const railKid =
    '-ml-px flex min-h-7 items-center py-1 pl-3 font-mono text-[10px] uppercase tracking-[0.12em] text-mid no-underline hover:text-ink';
  const toggleKids = (key: string, expanded: boolean) => setRailKids((prev) => ({ ...prev, [key]: !expanded }));
  const monolithModule = (item: CollapsibleGroupItem) => {
    const children = item.children.filter(canSeeChild);
    if (children.length === 0) return null;
    if (item.labelKey === 'securityCenter') return <NavFlyout key={item.labelKey} labelKey={item.labelKey} icon={item.icon}
      open={openKey === item.labelKey} active={children.some(isRowActive)} collapsed={false} rowBase={railRow}
      panelId={`nav-flyout-${item.labelKey}`} onOpen={() => setOpenKey(item.labelKey)}
      onToggle={() => setOpenKey(key => key === item.labelKey ? null : item.labelKey)}
      triggerRef={element => { triggerRefs.current[item.labelKey] = element; }}/>;
    const active =
      item.defaultHref || item.activeMatch === 'children'
        ? children.some(isRowActive)
        : isParentActive(pathname, children.flatMap(childPaths));
    const expanded = railKids[item.labelKey] ?? active;
    const label = t(item.labelKey);
    const kidsId = `rail-kids-${item.labelKey}`;
    // Exactly one child reads as the current page: the longest matching href (the flyout's own rule).
    const currentHref = children
      .filter((c) => isRowActive(c))
      .sort((a, b) => b.href.split('?')[0].length - a.href.split('?')[0].length)[0]?.href;
    const mark = (
      <span aria-hidden className="shrink-0 text-faint">
        {expanded ? '−' : '+'}
      </span>
    );
    return (
      <div key={item.labelKey} data-rail-module={item.labelKey} data-tour={item.tour}>
        {item.defaultHref ? (
          <div className={cn(railRow, 'pr-0', (active || expanded) && 'text-ink', active && 'border-ink')}>
            <Link prefetchOnIntentOnly href={item.defaultHref} className="min-w-0 flex-1 text-inherit no-underline">
              {label}
            </Link>
            <button
              type="button"
              aria-label={label}
              aria-expanded={expanded}
              aria-controls={kidsId}
              onClick={() => toggleKids(item.labelKey, expanded)}
              className="inline-flex min-h-7 items-center px-1"
            >
              {mark}
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={kidsId}
            onClick={() => toggleKids(item.labelKey, expanded)}
            className={cn(railRow, (active || expanded) && 'text-ink', active && 'border-ink')}
          >
            <span className="min-w-0">{label}</span>
            {mark}
          </button>
        )}
        {expanded && (
          <nav id={kidsId} aria-label={label} className="mt-0.5 mb-1.5 ml-2.5 flex flex-col border-l border-hairline">
            {(() => { const renderChild = (child: ChildItem, index: number) => {
              const current = child.href === currentHref;
              const heading=sectionLabel(child.href);
              return (
                <Fragment key={child.href}>
                {!child.submenuKey&&heading&&heading!==sectionLabel(children[index-1]?.href??'')&&<p className="mb-0 mt-2 px-3 text-xs text-muted-foreground">{t(heading)}</p>}
                <Link prefetchOnIntentOnly
                  key={child.href}
                  href={child.navigationHref??child.href}
                  data-tour={child.tour==='nav-admin'||child.tour==='nav-approvals'?undefined:child.tour}
                  aria-current={current ? 'page' : undefined}
                  className={cn(railKid, current && 'text-signal-text hover:text-signal-text')}
                >
                  {childCaption(child)}
                </Link>
                </Fragment>
              );
            }; return children.some(child => child.submenuKey)
              ? <NavigationSubmenus items={children} isActive={href => href === currentHref} renderItem={renderChild} triggerClassName={railKid}/>
              : children.map(renderChild); })()}
          </nav>
        )}
      </div>
    );
  };
  const monolithRail = () => (
    <>
      <Link prefetchOnIntentOnly
        href="/"
        aria-label={t('home')}
        className="block shrink-0 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-ink no-underline"
      >
        {/* The board's brand line. A mark, not copy (like `common.appName`, the same in every locale);
            the link's accessible name is the translated `nav.home`. */}
        AIHR <span className="text-mid">/ SYSTEM 01</span>
      </Link>
      <nav data-tour="nav" className="relative -mr-2 flex w-full flex-1 flex-col gap-[22px] overflow-y-auto overflow-x-hidden pr-2">
        {groups.map((group, gi) => (
          <div key={gi} className={cn('flex w-full flex-col gap-0.5',gi===2&&'mt-auto')}>
            {group.labelKey && !isWorkspaceKey(group.labelKey) && (
              <button
                type="button"
                onClick={() => toggleSection(group.labelKey!)}
                aria-expanded={sectionOpen(group.labelKey)}
                aria-controls={`nav-section-${group.labelKey}`}
                className="mb-1.5 flex w-full items-center justify-between border-b border-hairline pb-1.5 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-mid enabled:hover:text-ink"
              >
                <span>{t(group.labelKey)}</span>
                <span aria-hidden className="text-faint">
                  {sectionOpen(group.labelKey) ? '−' : '+'}
                </span>
              </button>
            )}
            <div id={group.labelKey ? `nav-section-${group.labelKey}` : undefined} className="flex w-full flex-col gap-0.5">
              {sectionOpen(group.labelKey) &&
                group.items.map((item) => {
                  if (isCollapsible(item)) return monolithModule(item);
                  const label = t(item.labelKey);
                  if (item.disabled) return (
                    <span key={item.href} aria-disabled="true" title={tWorkspace('planLocked')} className={cn(railRow, 'cursor-not-allowed hover:border-transparent hover:text-mid')}>
                      <span className="min-w-0">{label}</span>
                      <Lock aria-hidden className="size-3 shrink-0" />
                    </span>
                  );
                  const active = isRowActive(item);
                  const rowCount = item.href === '/tasks' ? taskCount : approvalCount;
                  const showApprovalCount = (item.href === '/approvals' || item.href === '/tasks') && rowCount > 0;
                  return (
                    <Link prefetchOnIntentOnly
                      key={item.href}
                      href={item.navigationHref ?? item.href}
                      data-tour={item.tour}
                      aria-label={showApprovalCount ? `${label}, ${t('approvalsCount', { count: rowCount })}` : label}
                      aria-current={active ? 'page' : undefined}
                      className={cn(railRow, active && 'border-ink text-ink hover:border-ink')}
                    >
                      <span className="min-w-0">{label}</span>
                      {showApprovalCount && (
                        <span aria-hidden className="shrink-0 text-[10px] tabular-nums text-signal-text">
                          {rowCount > 99 ? '99+' : rowCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
            </div>
            {gi===0&&workspaceSwitch()}
          </div>
        ))}
      </nav>
      {viewerName && (
        <p className="mono m-0 shrink-0 text-mid" data-rail-user>
          {viewerName}
          <br />
          {[viewerCode, locale.toUpperCase()].filter(Boolean).join(' · ')}
        </p>
      )}
    </>
  );

  // The review journey owns its 224px navigator and floating route back to the dashboard. Since D-P1-32 PT-X5 the
  // workspace is no longer a nav row of its own (its tab routes sit under Performance & Talent), so its address is
  // named here.
  if (pathname === REVIEW_WORKSPACE_PATH) return null;

  /* ── Atelier round 1 — THE ASSISTANT-FIRST RAIL (brief: .impeccable/surfaces/app-layout-tsx.md). Rendering
     only, like Monolith's: the SAME `groups`, `canSeeChild`, `isRowActive` and section state, so which rows
     exist, in which order, and which one is current cannot differ between themes. What differs: the
     workspace line, a Quick actions button (it opens the one command bar, lib/command-bar-events.ts), 16px
     icons on 30px rows, a separate theme-scoped submenu track, and the viewer at
     the foot. No collapse to an icon rail: like Monolith, the rail is always open on desktop. */
  if (atelier) {
    const atelierCount = (href: string) => {
      const n = href === '/tasks' ? taskCount : href === '/approvals' ? approvalCount : 0;
      return n > 0 ? n : null;
    };
    const atelierModule = (item: CollapsibleGroupItem) => {
      const children = item.children.filter(canSeeChild);
      if (children.length === 0) return null;
      const active = item.defaultHref || item.activeMatch === 'children'
        ? children.some(isRowActive) : isParentActive(pathname, children.flatMap(childPaths));
      const expanded = openNode?.labelKey === item.labelKey;
      const Icon = item.icon;
      const label = t(item.labelKey);
      const kidsId = `atelier-flyout-${item.labelKey}`;
      const flip = () => setOpenKey(item.labelKey === 'securityCenter' ? item.labelKey : expanded ? null : item.labelKey);
      const register = (element: HTMLButtonElement | null) => { triggerRefs.current[item.labelKey] = element; };
      // Collapsed (b953a339), a module is its icon: it opens the floating sub-menu, which lists every page
      // the module has — including a landing page, which is always one of its children.
      return (
        <div key={item.labelKey} data-atelier-module={item.labelKey} onPointerEnter={event => { if (item.labelKey === 'securityCenter' && event.pointerType === 'mouse') setOpenKey(item.labelKey); }}>
          {item.defaultHref && !collapsed ? (
            <div className={cn('atelier-row pr-0', active&&'bg-accent font-medium text-foreground')}>
              <Link prefetchOnIntentOnly href={item.defaultHref} onClick={()=>setMobileNavigationOpen(false)} className="flex min-w-0 flex-1 items-center gap-2.5 text-inherit no-underline">
                <Icon aria-hidden /><span className="truncate">{label}</span>
              </Link>
              <button ref={register} type="button" aria-label={label} aria-expanded={expanded} aria-controls={kidsId} onClick={flip}
                className="atelier-row atelier-module-toggle">
                <ChevronDown aria-hidden className="atelier-chevron" />
              </button>
            </div>
          ) : (
            <button ref={register} type="button" aria-expanded={expanded} aria-controls={kidsId} onClick={flip} title={collapsed ? label : undefined} className={cn('atelier-row', (active || expanded) && 'bg-accent font-medium text-foreground')}>
              <Icon aria-hidden /><span className="atelier-label truncate">{label}</span>
              <ChevronDown aria-hidden className="atelier-chevron" />
            </button>
          )}
        </div>
      );
    };
    const initials = (viewerName ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
    return (
      <div className="atelier-navigation-container" onKeyDown={event=>{
        if(event.key==='Escape'&&!openNode&&mobileNavigationOpen){event.preventDefault();setMobileNavigationOpen(false);mobileNavigationTrigger.current?.focus();}
      }}>
      <button ref={mobileNavigationTrigger} type="button" className="atelier-mobile-toggle" aria-expanded={mobileNavigationOpen} aria-controls="atelier-mobile-navigation"
        onClick={()=>{setMobileNavigationOpen(open=>!open);setOpenKey(null);}}>
        <PanelLeftOpen aria-hidden className="size-4"/><span>{t('workspaceSwitch')}</span>
      </button>
      <div id="atelier-mobile-navigation" className={cn('atelier-navigation-shell relative h-full shrink-0 sm:flex', mobileNavigationOpen?'flex':'hidden', openNode && 'atelier-flyout-open z-50', collapsed && 'atelier-collapsed')}>
        <aside data-app-sidebar data-atelier-navigation className="atelier-rail">
          <Link prefetchOnIntentOnly href="/" aria-label={t('home')} className="atelier-workspace">
            <span data-brand-tile aria-hidden>AI</span>
            <span className="atelier-label">{tCommon('appName')}</span>
          </Link>
          <button type="button" className="atelier-quick" onClick={() => openCommandBar('')} title={collapsed ? tBar('quickActions') : undefined}>
            <Command aria-hidden className="size-3.5 shrink-0" />
            <span className="atelier-label">{tBar('quickActions')}</span>
            <kbd aria-hidden>⌘K</kbd>
          </button>
          <nav data-tour="nav" aria-label={tCommon('appName')} className="atelier-nav">
            {groups.map((group, gi) => (
              <div key={gi}>
                {group.labelKey && !isWorkspaceKey(group.labelKey) && (collapsed ? (
                  // Collapsed there is no room for a heading to toggle, so every section shows its icons.
                  <div role="presentation" className="atelier-section atelier-section-static"><span>{t(group.labelKey)}</span></div>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleSection(group.labelKey!)}
                    aria-expanded={sectionOpen(group.labelKey)}
                    aria-controls={`nav-section-${group.labelKey}`}
                    className="atelier-section"
                  >
                    <span>{t(group.labelKey)}</span>
                    <ChevronDown aria-hidden className={cn('size-3.5 shrink-0', !sectionOpen(group.labelKey) && '-rotate-90')} />
                  </button>
                ))}
                <div id={group.labelKey ? `nav-section-${group.labelKey}` : undefined} className="flex flex-col gap-px">
                  {(collapsed || sectionOpen(group.labelKey)) && group.items.map((item) => {
                    if (isCollapsible(item)) return atelierModule(item);
                    const Icon = item.icon;
                    const label = t(item.labelKey);
                    if (item.disabled) return (
                      <span key={item.href} aria-disabled="true" title={collapsed ? `${label} — ${tWorkspace('planLocked')}` : tWorkspace('planLocked')} className="atelier-row cursor-not-allowed text-muted-foreground">
                        <Icon aria-hidden /><span className="atelier-label truncate">{label}</span><Lock aria-hidden className="ml-auto size-3.5 shrink-0" />
                      </span>
                    );
                    const count = atelierCount(item.href);
                    return (
                      <Link prefetchOnIntentOnly key={item.href} href={item.navigationHref ?? item.href} onClick={()=>setMobileNavigationOpen(false)} data-tour={item.tour}
                        aria-label={count ? `${label}, ${t('approvalsCount', { count })}` : label}
                        aria-current={isRowActive(item) ? 'page' : undefined} title={collapsed ? label : undefined} className="atelier-row">
                        <Icon aria-hidden /><span className="atelier-label truncate">{label}</span>
                        {count && <span aria-hidden className="atelier-count">{count > 99 ? '99+' : count}</span>}
                      </Link>
                    );
                  })}
                </div>
                {gi===0&&workspaceSwitch()}
              </div>
            ))}
          </nav>
          {/* b953a339 — Classic's collapse control, in Atelier's styling. Same remembered setting (rail_collapsed). */}
          <button type="button" onClick={toggle} aria-label={collapsed ? t('expand') : t('collapse')} title={collapsed ? t('expand') : t('collapse')}
            aria-pressed={collapsed} data-atelier-collapse className="atelier-row atelier-collapse">
            {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            <span className="atelier-label truncate">{collapsed ? t('expand') : t('collapse')}</span>
          </button>
          {viewerName && (
            <div className="atelier-user" data-rail-user title={collapsed ? viewerName : undefined}>
              <span aria-hidden className="atelier-avatar">{initials || '·'}</span>
              <div className="atelier-label min-w-0">
                <b className="truncate">{viewerName}</b>
                {viewerCode && <span>{viewerCode}</span>}
              </div>
            </div>
          )}
        </aside>
        {openNode && <NavFlyoutPanel key={openNode.labelKey} layout="atelier" labelKey={openNode.labelKey}
          items={openChildren.map(child=>({...child,sectionKey:sectionLabel(child.href),pendingCount:child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0})) as FlyoutChild[]}
          isActive={href=>href===activeChildHref} rowBase="atelier-row" panelId={`atelier-flyout-${openNode.labelKey}`}
          onClose={()=>{setOpenKey(null);setMobileNavigationOpen(false);}} onEscape={()=>{pendingTriggerFocus.current=openNode.labelKey;setOpenKey(null);}}/>}
      </div>
      </div>
    );
  }

  // D-P1-28 — below 640px Classic and Monolith used to hide the rail with no way to open it. A menu button (the label
  // and icon Atelier's phone toggle uses) opens the same rail as a drawer over the page; Escape, the backdrop or a
  // destination closes it, and focus returns to the button. The rail itself, and every breakpoint above 640px
  // (My Team's 900px included), is unchanged.
  const closeMobileNavigation = () => { setMobileNavigationOpen(false); mobileNavigationTrigger.current?.focus(); };
  return (
    <div className="contents" onKeyDown={event => {
      if (event.key === 'Escape' && !openNode && mobileNavigationOpen) { event.preventDefault(); closeMobileNavigation(); }
    }}>
    <button ref={mobileNavigationTrigger} type="button" data-mobile-navigation-toggle aria-expanded={mobileNavigationOpen} aria-controls="app-mobile-navigation"
      onClick={() => { setMobileNavigationOpen(open => !open); setOpenKey(null); }}
      className={cn('flex min-h-11 shrink-0 items-center gap-2.5 rounded-[1.25rem] border border-border bg-card px-4 text-left text-sm font-medium text-foreground shadow-[var(--shadow-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring monolith:mx-4 monolith:mt-4 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-hairline monolith:bg-background monolith:px-0 monolith:shadow-none sm:hidden')}>
      <PanelLeftOpen aria-hidden className="size-4 shrink-0" /><span>{t('workspaceSwitch')}</span>
    </button>
    {mobileNavigationOpen && <div aria-hidden="true" data-mobile-navigation-backdrop onClick={closeMobileNavigation}
      className="fixed inset-0 z-40 bg-black/40 sm:hidden" />}
    {/* Wrapper (fdc20776): the aside is overflow-hidden, so the flyout panel cannot live inside it —
        it anchors to this relative wrapper instead, which takes over the aside's responsive/flex-item
        classes (a bare wrapper would stay a visible zero-width flex item below sm and add a phantom
        layout gutter, and the aside's h-full needs the wrapper to have height). While a panel is open
        the wrapper is raised to z-50 so the rail rows stay clickable above the z-40 backdrop (module
        swap in one click); the raise is conditional so onboarding-tour stacking is unaffected otherwise. */}
    <div className={cn('relative hidden h-full shrink-0', pathname === '/manage/my-team' ? 'min-[900px]:block' : 'sm:block', openNode && 'z-50',
      // D-P1-28 — open on a phone: the same wrapper, fixed over the page above the backdrop.
      mobileNavigationOpen && 'max-sm:fixed max-sm:inset-y-0 max-sm:left-0 max-sm:z-50 max-sm:block max-sm:h-auto max-sm:p-3 monolith:max-sm:p-0')}>
    {/* r398 (parent): the Monolith rail follows Classic's breakpoints. The README hides it below 900px, but the app
        has no other way to open navigation at those widths, so hiding it would leave a tablet with no navigation. */}
      <aside
        id="app-mobile-navigation"
        data-app-sidebar
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-[1.25rem] border border-border bg-sidebar py-4 shadow-[var(--shadow-card)] transition-[width] duration-200 ease-snappy',
          collapsed ? 'w-[66px] items-center px-3' : 'w-[232px] px-3',
          // Above the panel's backdrop, so every rail row stays clickable while a panel is open.
          openNode && 'relative z-50',
          // r398 — Monolith (README §3): no floating panel — square, no shadow, one hairline on the right,
          // the board's 22/20/24/24 padding and 22px between blocks. Classic's computed style is untouched.
          'monolith:gap-[22px] monolith:rounded-none monolith:border-0 monolith:border-r monolith:border-hairline monolith:bg-background monolith:pt-[22px] monolith:pr-5 monolith:pb-6 monolith:pl-6 monolith:shadow-none',
        )}
      >
        {monolith ? monolithRail() : (<>
        <Link prefetchOnIntentOnly
          href="/"
          aria-label={t('home')}
          className={cn(
            'flex items-center gap-2.5 rounded-2xl transition duration-150 ease-snappy active:scale-95',
            collapsed ? 'justify-center' : 'px-1 py-0.5',
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-primary text-[13px] font-bold text-primary-foreground shadow-[var(--shadow-sm)]" aria-hidden>
            AI
          </span>
          {!collapsed && (
            <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-foreground">
              {tCommon('appName')}
            </span>
          )}
        </Link>

        {/* `relative` for the same reason as <main> in app/layout.tsx: absolute descendants
            (sr-only labels) must not escape this scroll container and create viewport overflow. */}
        <nav
          data-tour="nav"
          className="relative flex w-full flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3"
        >
          {groups.map((group, gi) => (
            <div key={gi} className={cn('flex w-full flex-col gap-1', collapsed && 'items-center',gi===2&&'mt-auto')}>
              {gi > 0 && collapsed && (
                <span className="my-1.5 h-px w-7 rounded-full bg-border" aria-hidden />
              )}
              {/* ⚠️ THE SECTION HEADING IS A CONTROL NOW, not a caption. In the icon rail there is no
                  heading to click (labels are hidden), so sections stay open there and the divider above
                  is unchanged — collapsing a nameless strip of icons would hide destinations behind a
                  chevron with nothing to say what is inside. */}
              {!collapsed && group.labelKey && !isWorkspaceKey(group.labelKey) && (
                <button
                  type="button"
                  onClick={() => toggleSection(group.labelKey!)}
                  aria-expanded={sectionOpen(group.labelKey)}
                  aria-controls={`nav-section-${group.labelKey}`}
                  className={cn(
                    'group/sec flex w-full items-center justify-between rounded-md px-2 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80',
                    // The first heading sits directly under the rail's own py-3, so its top padding is
                    // duplicate space. Reclaiming it is what brings the Admin section — the longest, at
                    // 15 rows — inside the viewport instead of one row over.
                    gi === 0 ? 'pt-0.5' : 'pt-2.5',
                    'hover:text-foreground',
                  )}
                >
                  <span>{t(group.labelKey)}</span>
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 transition-transform',
                      !sectionOpen(group.labelKey) && '-rotate-90',
                    )}
                  />
                </button>
              )}
              {/* The id `aria-controls` on the heading points at. Without a real element to reference,
                  the attribute is a dangling promise to a screen reader. */}
              <div
                id={group.labelKey ? `nav-section-${group.labelKey}` : undefined}
                className={cn('flex w-full flex-col gap-1', collapsed && 'items-center')}
              >
              {(collapsed || sectionOpen(group.labelKey)) &&
              group.items.map((item) => {
                if (isCollapsible(item)) {
                  const children = item.children.filter(canSeeChild);
                  // Hide the whole parent if the viewer can see none of its children.
                  if (children.length === 0) return null;
                  if (item.defaultHref && !collapsed) {
                    const active = children.some(isRowActive);
                    const expanded = inlineOpen[item.labelKey] ?? (active || openKey === item.labelKey);
                    const Icon = item.icon;
                    return <div key={item.labelKey}>
                      <div className={cn(rowBase, 'w-full gap-1 px-3 py-1', active && 'bg-accent')}>
                        <Link prefetchOnIntentOnly href={item.defaultHref} className="flex min-h-11 min-w-0 flex-1 items-center gap-3"><Icon className="size-5 shrink-0" aria-hidden /><span className="text-sm">{t(item.labelKey)}</span></Link>
                        <button type="button" aria-label={t(item.labelKey)} aria-expanded={expanded} aria-controls={`inline-${item.labelKey}`} className="flex size-11 shrink-0 items-center justify-center" onClick={() => setInlineOpen(old=>({...old,[item.labelKey]:!expanded}))}><ChevronDown className={cn('size-4', !expanded && '-rotate-90')} aria-hidden /></button>
                      </div>
                      {expanded && <nav id={`inline-${item.labelKey}`} aria-label={t(item.labelKey)} className="ml-7 flex flex-col gap-1">{children.map((child) => <Link prefetchOnIntentOnly key={child.href} href={child.href} aria-current={isRowActive(child) ? 'page' : undefined} className={cn('flex min-h-11 items-center rounded-xl px-3 text-sm', isRowActive(child) ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-accent')}>{childCaption(child)}</Link>)}</nav>}
                    </div>;
                  }
                  return (
                    <NavFlyout
                      key={item.labelKey}
                      labelKey={item.labelKey}
                      icon={item.icon}
                      open={openKey === item.labelKey}
                      active={item.defaultHref || item.activeMatch === 'children' ? children.some(isRowActive) : isParentActive(pathname, children.flatMap(childPaths))}
                      collapsed={collapsed}
                      rowBase={rowBase}
                      panelId={`nav-flyout-${item.labelKey}`}
                      onOpen={item.labelKey === 'securityCenter' ? () => setOpenKey(item.labelKey) : undefined}
                      onToggle={() =>
                        setOpenKey((k) => (k === item.labelKey ? null : item.labelKey))
                      }
                      triggerRef={(el) => {
                        triggerRefs.current[item.labelKey] = el;
                      }}
                      tour={item.tour}
                    />
                  );
                }
                const Icon = item.icon;
                const label = t(item.labelKey);
                if (item.disabled) return (
                  <span key={item.href} aria-disabled="true" title={tWorkspace('planLocked')}
                    className={cn(rowBase, collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2', 'cursor-not-allowed text-muted-foreground')}>
                    <Icon className="size-[20px] shrink-0" strokeWidth={2} aria-hidden />
                    {!collapsed && <span className="truncate text-sm">{label}</span>}
                    {!collapsed && <Lock className="ml-auto size-4 shrink-0" aria-hidden />}
                  </span>
                );
                const active = isRowActive(item);
                // Pending-approval badge (feedback 836118c4). Keyed on the href, like every other
                // row-specific behaviour in this file — no marker field on the Item type. The count
                // arrives pre-computed from the layout; a viewer without the row never reaches here.
                const rowCount = item.href === '/tasks' ? taskCount : approvalCount;
                  const showApprovalCount = (item.href === '/approvals' || item.href === '/tasks') && rowCount > 0;
                return (
                  <Link prefetchOnIntentOnly
                    key={item.href}
                    href={item.navigationHref ?? item.href}
                    data-tour={item.tour}
                    title={collapsed ? label : undefined}
                    // The badge itself is aria-hidden, so the count reaches screen readers here —
                    // otherwise the rail would announce "Approval Items" whether 0 or 12 are waiting.
                    aria-label={showApprovalCount ? `${label}, ${t('approvalsCount', { count: rowCount })}` : label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      rowBase,
                      collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
                      // Anchors the collapsed-rail badge bubble over the icon square.
                      showApprovalCount && 'relative',
                      active
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon
                      className={cn('size-[20px] shrink-0', active && 'text-primary')}
                      strokeWidth={2}
                    />
                    {!collapsed && <span className="truncate text-sm">{label}</span>}
                    {showApprovalCount && (
                      <ApprovalCountBadge count={rowCount} collapsed={collapsed} />
                    )}
                  </Link>
                );
              })}
              </div>
              {gi===0&&workspaceSwitch()}
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('expand') : t('collapse')}
          title={collapsed ? t('expand') : t('collapse')}
          className={cn(
            rowBase,
            'mt-2 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            // The desktop collapse preference does nothing in the phone drawer (D-P1-28).
            mobileNavigationOpen && 'max-sm:hidden',
            collapsed ? 'size-11 justify-center' : 'w-full gap-3 px-3 py-2',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[20px] shrink-0" strokeWidth={2} />
          ) : (
            <>
              <PanelLeftClose className="size-[20px] shrink-0" strokeWidth={2} />
              <span className="truncate text-sm">{t('collapse')}</span>
            </>
          )}
        </button>
        </>)}
      </aside>

      {openNode && (
        <NavFlyoutPanel
          labelKey={openNode.labelKey}
          items={openChildren.map(child=>({...child,sectionKey:sectionLabel(child.href),tour:child.tour==='nav-admin'||child.tour==='nav-approvals'?undefined:child.tour,navigationHref:child.navigationHref,pendingCount:child.href==='/tasks'?taskCount:child.href==='/approvals'?approvalCount:0})) as FlyoutChild[]}
          isActive={(href) => href === activeChildHref}
          rowBase={rowBase}
          panelId={`nav-flyout-${openNode.labelKey}`}
          onClose={() => setOpenKey(null)}
          onEscape={() => {
            setOpenKey(null);
            triggerRefs.current[openNode.labelKey]?.focus();
          }}
        />
      )}
    </div>
    </div>
  );
}
