/**
 * Lifecycle built-in reference data (ADR-0095) — the CHGB handover's step lists, checklists, access
 * systems, approval levels, request catalogue and per-company extra fields, as PURE DATA.
 *
 * A tenant that has not edited a list reads these defaults; the first admin edit materialises the rows
 * (core/lifecycle-config.ts). Defaults are keyed by the company's SHORT CODE (`company.company_label`,
 * e.g. CHGP) because the handover's "business group" IS a company here — a tenant whose companies carry no
 * such label simply gets the common lists. Source: 03_Reference_Data/*.json of the handover package, which
 * the business may change (step lists, owners and approval levels are the part most likely to).
 */
export type StepRule = 'always' | 'carpark' | 'laptop' | 'outcome_accepted' | 'outcome_rejected';
export type CaseKind = 'onboarding' | 'offboarding';

export type StepDefault = {
  key: string;
  phase: number;
  label: string;
  ownerTeam: string;
  hrms?: boolean;
  rule: StepRule;
};

export const ONBOARDING_PHASES: Record<number, string> = { 0: 'Pre-onboarding & set-up', 1: 'Day 1', 2: 'Day 7–14' };
export const OFFBOARDING_PHASES: Record<number, string> = { 0: 'Notification & initiation', 1: 'Processing' };

const s = (key: string, phase: number, label: string, ownerTeam: string, rule: StepRule = 'always', hrms = false): StepDefault => ({
  key, phase, label, ownerTeam, rule, ...(hrms ? { hrms: true } : {}),
});

export const ONBOARDING_STEPS: readonly StepDefault[] = [
  s('hrms_sync', 0, 'Confirm HRMS sync & update new hire info', 'GBS People Ops', 'always', true),
  s('hrms_employee_create', 0, 'Create employee record in HRMS — salary band, cost centre & reporting line', 'GBS People Ops', 'always', true),
  s('bank_account', 0, 'Collect new hire bank account details for payroll setup', 'GBS People Ops'),
  s('statutory_enrol', 0, 'Enrol employee in EPF / SOCSO / EIS', 'GBS People Ops', 'always', true),
  s('p_file', 0, 'Record employee p-file', 'GBS People Ops'),
  s('notify_assets', 0, 'Notify Group Tech & BG Admin — ID card and systems access', 'GBS People Ops'),
  s('seat', 0, 'Assign seating', 'PBP / Supervisor'),
  s('carpark', 0, 'Assign car park bay', 'PBP / Supervisor', 'carpark'),
  s('buddy', 0, 'Assign onboarding buddy', 'PBP / Supervisor'),
  s('ta_confirm', 0, 'GBS TA consolidates new hire info & shares to GBS Ops', 'GBS TA'),
  s('it_prep', 0, 'Notify Group Tech for laptop & email preparation (see linked ITR)', 'GBS TA'),
  s('welcome_mail', 0, 'Send welcome email to new hire', 'GBS TA'),
  s('sys_access_confirm', 1, 'Confirm email, AD account & system access are live', 'GBS TA'),
  s('tour', 1, 'Office tour to common areas', 'GBS TA'),
  s('orientation', 1, 'Day 1 orientation & HR briefing', 'GBS TA'),
  s('laptop_dist', 1, 'Laptop distributed by Group Tech (see linked ITR)', 'Group Tech'),
  s('daa_ack', 1, 'New hire completes Device Acceptance Acknowledgement', 'New Hire', 'laptop'),
  s('pbp_welcome', 1, 'PBP/Supervisor welcomes new hire', 'PBP / Supervisor'),
  s('bg_intro', 2, 'PBP conducts BG introduction to new hire', 'PBP / Supervisor'),
  s('survey', 2, 'Send onboarding satisfaction survey', 'GBS TA'),
];

/** The step the new hire ticks themselves, through the public acknowledgement link. */
export const ONBOARDING_DAA_STEP = 'daa_ack';
/** Marking this done (when a laptop is required) generates the acknowledgement link. */
export const ONBOARDING_LAPTOP_DIST_STEP = 'laptop_dist';
export const OFFBOARDING_OUTCOME_STEP = 'resign_outcome';

export const OFFBOARDING_STEPS: readonly StepDefault[] = [
  s('resign_submit', 0, 'Employee submits Resignation to Supervisor', ''),
  s('resign_share_pbp', 0, 'Supervisor communicates with Employee and shares Resignation Letter to PBP', ''),
  s('exit_align', 0, "Supervisor and PBP discuss and align on Employee's exit", ''),
  s('resign_outcome', 0, 'Record resignation outcome (Accept / Reject for retention)', ''),
  s('retention_bg_approval', 0, 'PBP, Supervisor and BG CEO approve for retention', '', 'outcome_rejected'),
  s('retention_pbp_instr', 0, 'PBP submits instruction to GBS for e-Letter generation', '', 'outcome_rejected'),
  s('retention_eletter_gen', 0, 'GBS People Ops generates retention e-Letter & updates HRMS', '', 'outcome_rejected'),
  s('retention_eletter_share', 0, 'GBS People Ops shares retention e-Letter to PBP', '', 'outcome_rejected'),
  s('retention_eletter_ext', 0, 'PBP extends retention e-Letter to Employee', '', 'outcome_rejected'),
  s('p_file_initiation', 0, 'Record employee p-file (retention outcome)', '', 'outcome_rejected'),
  s('share_resign_letter', 1, 'PBP shares Resignation Letter and exit info to GBS', '', 'outcome_accepted'),
  s('hrms_leave_aor', 1, 'Update HRMS, check leave balance & generate AOR e-Letter', '', 'outcome_accepted'),
  s('confirm_last_day', 1, 'Share leave balance with PBP; confirm last day, leave utilisation & encashment', '', 'outcome_accepted'),
  s('email_aor', 1, 'Email AOR e-Letter, offboarding checklist & Exit Interview form to Employee', '', 'outcome_accepted'),
  s('handover', 1, 'Employee completes knowledge transfer and work handover to supervisor / replacement', '', 'outcome_accepted'),
  s('exit_interview', 1, 'PBP conducts Exit Interview and offboarding with Employee', '', 'outcome_accepted'),
  s('share_exit_form', 1, 'Share completed Exit Interview Form to PBP before last day', '', 'outcome_accepted'),
  s('it_asset_return', 1, 'Employee returns IT assets — laptop, access card & car park pass (see linked ITR)', '', 'outcome_accepted'),
  s('sys_access_revoke', 1, 'Group Tech revokes AD account, email & system access on last working day', '', 'outcome_accepted'),
  s('final_payroll', 1, 'GBS Payroll processes final salary, leave encashment & deductions', '', 'outcome_accepted', true),
  s('p_file_final', 1, 'Record employee p-file (offboarding complete)', '', 'outcome_accepted'),
];

export type ProvisionDefault = { key: string; name: string; sort: number };

export const REQUISITION_COMMON: readonly ProvisionDefault[] = [
  { key: 'email_create', name: 'Create Email / M365 Account', sort: 10 },
  { key: 'ad_create', name: 'Create AD Account', sort: 20 },
  { key: 'laptop_issue', name: 'Issue Laptop / Device', sort: 30 },
  { key: 'vpn', name: 'Configure VPN Access', sort: 40 },
  { key: 'kingdee', name: 'Kingdee ERP Access', sort: 50 },
  { key: 'flex_hr', name: 'Flex HR Access', sort: 60 },
  { key: 'pmtm', name: 'Chin Hin System (PMTM)', sort: 70 },
  { key: 'access_card', name: 'Issue Access Card', sort: 80 },
];
export const REQUISITION_BY_COMPANY: Record<string, readonly ProvisionDefault[]> = {
  CHGP: [
    { key: 'mytepro', name: 'MytePro Access', sort: 90 },
    { key: 'rr_account', name: 'RR Account (TBP create, TGBS install)', sort: 91 },
    { key: 'mhw_kpa', name: 'MHW-KPA (TBP create, TGBS install)', sort: 92 },
    { key: 'car_park', name: 'Car Park Pass (if applicable)', sort: 93 },
  ],
  SIGN: [
    { key: 'project_odoo', name: 'Project Odoo (Job Role)', sort: 90 },
    { key: 'sfm', name: 'SFM (Job Role)', sort: 91 },
    { key: 'pots', name: 'POTS (Job Role)', sort: 92 },
    { key: 'autocad', name: 'AutoCAD', sort: 93 },
    { key: 'gstar_cad', name: 'GSTAR CAD', sort: 94 },
  ],
};
export const RETURN_COMMON: readonly ProvisionDefault[] = [
  { key: 'asset_return', name: 'Device Physically Received & Tagged', sort: 10 },
  { key: 'email_deactivate', name: 'Email Account Deactivated', sort: 20 },
  { key: 'auto_reply', name: 'Auto-Reply Email Set', sort: 30 },
  { key: 'shared_mailbox', name: 'Email → Shared Mailbox', sort: 40 },
  { key: 'onedrive_migrate', name: 'OneDrive Migrated to Superior', sort: 50 },
  { key: 'email_group_rm', name: 'Email Distribution Groups Removed', sort: 60 },
  { key: 'ad_deactivate', name: 'AD Account Deactivated', sort: 70 },
  { key: 'license_revoke', name: 'M365 License Revoked', sort: 80 },
  { key: 'vpn_revoke', name: 'VPN Access Revoked', sort: 90 },
  { key: 'kingdee_revoke', name: 'Kingdee ERP Access Revoked', sort: 100 },
  { key: 'flex_hr_revoke', name: 'Flex HR Access Revoked', sort: 110 },
  { key: 'pmtm_revoke', name: 'PMTM Access Revoked', sort: 120 },
];
export const RETURN_BY_COMPANY: Record<string, readonly ProvisionDefault[]> = {
  CHGP: [
    { key: 'mytepro_revoke', name: 'MytePro Access Revoked', sort: 130 },
    { key: 'mhw_revoke', name: 'MHW Account Deactivated (TBP)', sort: 131 },
    { key: 'novade_revoke', name: 'Novade Account Deactivated (TBP)', sort: 132 },
    { key: 'outperform_reset', name: 'Outperform Shared ID PW Reset (TBP)', sort: 133 },
  ],
  SIGN: [
    { key: 'project_odoo_rev', name: 'Project Odoo Access Revoked', sort: 130 },
    { key: 'sfm_rev', name: 'SFM Access Revoked', sort: 131 },
    { key: 'pots_rev', name: 'POTS Access Revoked', sort: 132 },
    { key: 'autocad_rev', name: 'AutoCAD License Released', sort: 133 },
    { key: 'gstar_rev', name: 'GSTAR CAD License Released', sort: 134 },
  ],
};
/** Provision keys the asset hand-offs hang off. */
export const PROVISION_LAPTOP_ISSUE = 'laptop_issue';
export const PROVISION_ASSET_RETURN = 'asset_return';

/** Approval levels by company short code (0 = none needed, 1 = one approver, 2 = L1 then L2). */
export const APPROVAL_LEVELS_BY_COMPANY: Record<string, 0 | 1 | 2> = { CHBM: 2, CHCE: 2, CHGP: 0, SIGN: 1, FIAMMA: 1 };
export const DEFAULT_APPROVAL_LEVELS = 1;

const BASE_ACCESS = ['M365 Email & Teams', 'Active Directory', 'Kingdee ERP', 'Flex HR', 'FortiVPN', 'PMTM'];
export const ACCESS_SYSTEMS_BY_COMPANY: Record<string, readonly string[]> = {
  CHGP: ['M365 Email & Teams', 'Active Directory', 'MytePro', 'Kingdee ERP', 'Flex HR', 'FortiVPN', 'PMTM', 'RR Account', 'MHW-KPA', 'Novade', 'Outperform'],
  SIGN: ['M365 Email & Teams', 'Active Directory', 'Project Odoo', 'SFM', 'POTS', 'AutoCAD', 'GSTAR CAD', 'Kingdee ERP', 'Flex HR', 'FortiVPN', 'PMTM'],
};
export const DEFAULT_ACCESS_SYSTEMS: readonly string[] = BASE_ACCESS;

export type CatalogueDefault = { itemCode: string; itemName: string; category: 'hardware' | 'software'; description: string; approvalLevels: 1 | 2 };
export const ASSET_CATALOGUE: readonly CatalogueDefault[] = [
  { itemCode: 'HW-001', itemName: 'Laptop', category: 'hardware', description: 'Standard business laptop', approvalLevels: 2 },
  { itemCode: 'HW-002', itemName: 'Desktop / Workstation', category: 'hardware', description: 'Desktop computer or workstation', approvalLevels: 2 },
  { itemCode: 'HW-003', itemName: 'Monitor', category: 'hardware', description: 'External display monitor', approvalLevels: 1 },
  { itemCode: 'HW-004', itemName: 'Keyboard / Mouse / Accessories', category: 'hardware', description: 'Peripherals and accessories', approvalLevels: 1 },
  { itemCode: 'HW-005', itemName: 'Mobile Phone / Tablet', category: 'hardware', description: 'Corporate mobile device or tablet', approvalLevels: 2 },
  { itemCode: 'HW-006', itemName: 'Printer / Scanner', category: 'hardware', description: 'Printing and scanning equipment', approvalLevels: 2 },
  { itemCode: 'SW-001', itemName: 'Microsoft 365 License', category: 'software', description: 'M365 productivity suite license', approvalLevels: 1 },
  { itemCode: 'SW-002', itemName: 'Antivirus / Endpoint Protection', category: 'software', description: 'Endpoint security software', approvalLevels: 1 },
  { itemCode: 'SW-003', itemName: 'Project / ERP System Access', category: 'software', description: 'Odoo, SFM, POTS or similar', approvalLevels: 1 },
  { itemCode: 'SW-004', itemName: 'CAD / Design Software', category: 'software', description: 'AutoCAD, GSTAR CAD or similar', approvalLevels: 2 },
  { itemCode: 'SW-005', itemName: 'VPN Access', category: 'software', description: 'Remote access VPN provisioning', approvalLevels: 1 },
  { itemCode: 'SW-006', itemName: 'Other Software / License', category: 'software', description: 'Any other software not listed above', approvalLevels: 1 },
];

export const ASSET_TYPES = ['laptop', 'desktop', 'tablet', 'monitor', 'printer', 'mobile', 'peripheral', 'other'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export const ASSET_TYPE_CODE: Record<AssetType, string> = {
  laptop: 'LAP', desktop: 'DKT', tablet: 'TAB', monitor: 'MON', printer: 'PRT', mobile: 'MOB', peripheral: 'PRP', other: 'OTH',
};
export const ASSET_STATUSES = ['in_stock', 'issued', 'returned', 'under_repair', 'retired', 'written_off'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_REQUEST_STATUSES = [
  'requested', 'pending_approval', 'approved', 'procured', 'tagged', 'assigned', 'completed', 'rejected', 'cancelled',
] as const;
export type AssetRequestStatus = (typeof ASSET_REQUEST_STATUSES)[number];

export type CustomFieldType = 'text' | 'longtext' | 'number' | 'date' | 'yesno' | 'choice';
export type CustomFieldDefault = { key: string; label: string; type: CustomFieldType; options?: string[] };

const yn = (key: string, label: string): CustomFieldDefault => ({ key, label, type: 'yesno' });
const tx = (key: string, label: string): CustomFieldDefault => ({ key, label, type: 'text' });
/** The handover's per-business-group extra fields (brief 4.1 and 5.1), as staff-only custom fields. */
export const CUSTOM_FIELDS_BY_COMPANY: Record<string, { onboarding: readonly CustomFieldDefault[]; offboarding: readonly CustomFieldDefault[] }> = {
  CHCE: {
    onboarding: [tx('phone_no', 'Phone no.'), tx('it_equipment_ordered', 'IT equipment ordered'), { key: 'it_delivery_date', label: 'IT delivery date', type: 'date' }, tx('email_temp_password_issued', 'Email temporary password issued (Yes/No)')],
    offboarding: [tx('email_route_to', 'Email route-to'), { key: 'retain_months', label: 'Retain months', type: 'number' }, { key: 'password_reset_date', label: 'Password-reset date', type: 'date' }, { key: 'shared_mailbox_date', label: 'Shared-mailbox date', type: 'date' }],
  },
  CHGP: {
    onboarding: [tx('job_grade', 'Job grade'), tx('hp_mobile', 'HP mobile'), tx('car_plate_model', 'Car plate and model'), tx('buddy_name', 'Buddy'), yn('business_card', 'Business card'), yn('petrol_claim', 'Petrol claim'), yn('mytepr_access', 'MytePR access'), yn('rr_account', 'RR account'), yn('mhw_account', 'MHW account'), yn('sharepoint_permission', 'SharePoint permission')],
    offboarding: [yn('email_dist_removed', 'Email distribution removed'), yn('teams_group_removed', 'Teams group removed'), yn('mytepr_revoked', 'MytePR revoked'), yn('rr_deactivated', 'RR deactivated'), yn('mhw_deactivated', 'MHW deactivated'), yn('novade_deactivated', 'Novade deactivated'), yn('outperform_reset', 'Outperform reset'), yn('approval_route_removed', 'Approval route removed')],
  },
  SIGN: {
    onboarding: [yn('ms_apps', 'MS apps'), yn('project_odoo', 'Project Odoo'), yn('sfm', 'SFM'), yn('pots', 'POTS'), yn('autocad', 'AutoCAD'), yn('gstarcad', 'GstarCAD')],
    offboarding: [yn('project_odoo_revoked', 'Project Odoo revoked'), yn('sfm_revoked', 'SFM revoked'), yn('pots_revoked', 'POTS revoked'), yn('autocad_returned', 'AutoCAD returned'), yn('gstarcad_returned', 'GstarCAD returned')],
  },
  FIAMMA: {
    onboarding: [tx('unifi', 'UniFi'), tx('mobile_number', 'Mobile number'), tx('type_of_hiring', 'Type of hiring'), tx('laptop_setup_status', 'Laptop set-up status')],
    offboarding: [yn('micare_removed', 'MiCare removed'), yn('ge_removed', 'GE removed')],
  },
  CHBM: { onboarding: [tx('plant_site', 'Plant / site')], offboarding: [] },
};

/** A company's short code, normalised for matching and for asset-code prefixes. */
export function normaliseCompanyCode(label: string | null | undefined): string {
  return String(label ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
