/**
 * The Lifecycle module pack (ADR-0095): employee ONBOARDING and OFFBOARDING cases, IT requisitions,
 * the asset register and asset requests — the CHGB handover (2026-10-07).
 *
 * NOT the first-login product tour. `core/onboarding.ts` (ADR-0018) onboards a SYSTEM USER to the
 * product; this module onboards an EMPLOYEE to the company. Nothing here touches app_user.onboarded_at.
 *
 * Client-safe declaration only (the sidebar imports it): lucide refs and flat data. The service surface
 * lives behind `./service`.
 *
 * ## Pack surface
 * - Services (reachable from outside ONLY via `packs/lifecycle/service`): `core/lifecycle-*.ts`.
 * - Routes: `app/lifecycle/**` (everyone: asset requests; staff: cases, requisitions, assets),
 *   `app/admin/lifecycle/**` (Module Config: staff, checklists, catalogue, custom fields),
 *   `app/daa/**` (the public Device Acceptance form, token-gated, no login).
 *
 * ## Identity and ownership (CLAUDE.md §1)
 * A case holds the new hire's details itself: the person has no employment until HR creates it, so
 * `lc_case.person_id` / `employment_id` are optional links, never a copy of truth the other way. The
 * resignation workflow (`core/offboarding.ts`, ADR-0042) remains the ONLY owner of termination; an
 * offboarding CASE here is the checklist that follows it and does not end employment.
 *
 * ## Authorization
 * The handover's Agent / Manager roles are NOT line managers: `lc_staff` names them per company. Admins
 * (hr_admin / super_admin) are always staff. Everyone else is a requester and sees only their own asset
 * requests. RLS (migration 0516) is the wall; the services apply the finer rules.
 */
import { Laptop } from 'lucide-react';
import { V9_NAVIGATION, V9_SHARED_NAVIGATION } from '@/lib/lifecycle-v9-navigation';
import { registerPack, type ModulePack, type NavLinkDescriptor } from '../registry';
const LIFECYCLE_NAV_LINKS: NavLinkDescriptor[] = [
    ...V9_NAVIGATION.map(item => ({ group: 'manage' as const, href: item.href, labelKey: item.labelKey, icon: Laptop, exactHref: true, ...('ownedSubpaths' in item ? { ownedSubpaths: [...item.ownedSubpaths] } : {}) })),
    { group: 'manage', href: '/lifecycle/v9', labelKey: 'onboardingOffboarding', icon: Laptop },
    { group: 'manage', href: '/me/lifecycle', labelKey: 'myLifecycle', icon: Laptop },
    { group: 'manage', href: '/lifecycle/requisitions/onboarding', labelKey: 'onboardingRequisitions', icon: Laptop },
    { group: 'main', href: '/lifecycle', labelKey: 'lifecycle', icon: Laptop },
    { group: 'admin', href: '/admin/lifecycle', labelKey: 'lifecycleConfig', icon: Laptop },
    { group: 'admin', href: '/admin/lifecycle/onboarding', labelKey: 'onboardingSettings', icon: Laptop, exactHref: true },
    { group: 'admin', href: '/admin/lifecycle/onboarding/groups', labelKey: 'onboardingGroups', icon: Laptop },
    { group: 'admin', href: '/admin/lifecycle/onboarding/access', labelKey: 'onboardingModuleAccess', icon: Laptop },
    ...V9_SHARED_NAVIGATION.map(item => ({group: 'main' as const, href: item.href, labelKey: item.labelKey, icon: Laptop, exactHref: true})),
];
export const lifecyclePack: ModulePack = {
    id: 'lifecycle',
    kind: 'module',
    navLinks: LIFECYCLE_NAV_LINKS,
    navNodes: [{ group: 'manage', labelKey: 'onboardingV31', icon: Laptop, defaultHref: '/lifecycle/onboarding', children: [{ href: '/lifecycle/onboarding', labelKey: 'newJoiners', icon: Laptop, exactHref: true, ownedSubpaths: ['/lifecycle/onboarding/cases', '/lifecycle/onboarding/legacy'] }, { href: '/lifecycle/onboarding/checklists', labelKey: 'onboardingChecklists', icon: Laptop }] }],
    satelliteTables: [
        { table: 'lc_v9_config', note: 'V9 published document, email, checklist and workflow definitions' },
        { table: 'lc_v9_config_revision', note: 'Immutable V9 configuration revisions' },
        { table: 'lc_v9_case', note: 'Company-scoped V9 case and document executions' },
        { table: 'lc_v9_case_revision', note: 'Immutable V9 case revisions' },
        { table: 'lc_v9_file', note: 'Authorized case document and email files' },
        { table: 'lc_v9_payroll_handover', note: 'Frozen clearance figures for Payroll review' },
        { table: 'lc_onboarding_config', note: 'V3.1 versioned definitions and independent module access' },
        { table: 'lc_onboarding_config_history', note: 'Immutable configuration revisions' },
        { table: 'lc_onboarding_case', note: 'Personnel source identity, task and requisition generations' },
        { table: 'lc_onboarding_case_revision', note: 'Immutable public case revisions' },
        { table: 'lc_onboarding_private_revision', note: 'Immutable HR-only case revisions' },
        { table: 'lc_onboarding_private', note: 'HR-only case values behind separate RLS' },
        { table: 'lc_onboarding_note', note: 'Task and requisition conversation history' },
        { table: 'lc_onboarding_seen', note: 'Per-user joiner seen state, separate from notification reads' },
        { table: 'lc_onboarding_notice', note: 'Login-based notifications, including users without employment' },
        { table: 'lc_staff', note: 'module staff (agent / manager) per company; admins are implicit' },
        { table: 'lc_counter', note: 'per-tenant display numbers: ONB- OFB- ITR- AR- and BG-TYPE asset codes' },
        { table: 'lc_step_def', note: 'configurable onboarding / offboarding step definitions' },
        { table: 'it_provision_def', note: 'configurable requisition / return checklist items' },
        { table: 'lc_custom_field', note: 'admin-defined staff-only extra fields on cases' },
        { table: 'lc_company_config', note: 'IT approval levels and access systems per company' },
        { table: 'lc_case', note: 'onboarding and offboarding cases' },
        { table: 'lc_case_step', note: 'which steps of a case are done, by whom, when' },
        { table: 'lc_history', note: 'readable timeline for cases, requisitions, assets and asset requests' },
        { table: 'lc_comment', note: 'staff comments on a case' },
        { table: 'it_requisition', note: 'IT requisition / return / standalone, with the L1-L2 approval trail' },
        { table: 'it_requisition_item', note: 'provisioning checklist items of a requisition' },
        { table: 'it_asset', note: 'the IT asset register' },
        { table: 'it_asset_catalogue', note: 'what an employee may request, with approval levels' },
        { table: 'it_asset_request', note: 'asset requests: approve, procure, tag, assign, complete' },
    ],
    serviceFacade: 'packs/lifecycle/service',
};
registerPack(lifecyclePack);
