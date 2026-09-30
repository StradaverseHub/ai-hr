'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
// 9da61c86 — the Holiday master pages, so its row actions have to answer WHICH page a row is on.
import { pageOfIndex, parsePageSize } from '@/lib/pagination';
import { mergeEmploymentSelection } from '@/lib/employment-selection';
import { grantAssistant, revokeAssistant } from '@/core/assistant-grant';
import {
  archiveBusinessUnit,
  archiveCompany,
  archiveCostCenter,
  archiveDepartment,
  archiveLeaveType,
  archivePosition,
  assignRole,
  createBusinessUnit,
  createCompany,
  createCostCenter,
  createDepartment,
  createHoliday,
  createHolidayGroup,
  listHolidays,
  createLeaveType,
  createPosition,
  deleteHoliday,
  deleteHolidayGroup,
  updateHoliday,
  updateHolidayGroup,
  deleteCompany,
  deleteCostCenter,
  deleteDepartment,
  deleteLeaveType,
  deletePosition,
  revokeRole,
  setCompanyParent,
  setCompanyDefaultPayrollCycle,
  setCompanyLogo,
  removeCompanyLogo,
  setLeaveHalfDayFullDeductionCompanies,
  updateBusinessUnit,
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeaveType,
  updatePosition,
  setLeaveTypeRules,
  LeaveTypeRuleError,
} from '@/core/admin';
import {
  accrueEarnedLeave,
  asOfForLeaveYear,
  // bc36c768 — the leave-type counterpart of the scheme cohort, fired after an earning-method save clears
  // the NOT-CONFIGURED marker.
  reprojectEntitlementForLeaveTypeCohort,
  todayInKualaLumpur,
  DAY_TYPE_INCLUSION_KEYS,
  type DayTypeInclusion,
  type EarnedAccrualGroup,
  type LeaveDurationType,
  type LeaveEligibility,
  // 8fec719e — one row of the custom rounding table, parsed out of the editor's single JSON field.
  type RoundingBand,
  type ServiceBand,
} from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
// 93249794 — the Generate Entitlement run. `openLeaveYear` is no longer imported here: this file reaches
// the grant sweep THROUGH core/leave-generation.ts, which calls it and writes the processing log, so the
// engine has one entry point from the app layer instead of two.
import { runLeaveGeneration } from '@/packs/leave/service';
import { leaveGenerationMessages } from '@/lib/leave-generation-message';
import { orgCriteriaFromFields } from '@/core/org-criteria';
// Override Leave Application (56910869): the trigger list the form iterates, so the card and the parser
// cannot disagree about which rows exist.
import { LEAVE_OVERRIDE_TRIGGERS, type LeaveOverrideAction } from '@/core/leave-override';
import { setAttendancePolicy } from '@/packs/attendance/service';
import {
  createLocation,
  updateLocation,
  archiveLocation,
  restoreLocation,
  LocationBranchTakenError,
  LocationCodeTakenError,
} from '@/core/location';
import {
  createClockingLocation,
  updateClockingLocation,
  archiveClockingLocation,
  restoreClockingLocation,
  deleteClockingLocation,
  ClockingLocationInUseError,
  ClockingLocationNameTakenError,
  type ClockingLocationWriteResult,
  type RadiusAdvisory,
} from '@/packs/attendance/service';
import {
  CLOCKING_FIELDS,
  CLOCKING_NEW_PAGE,
  LOCATIONS_LIST,
  UUID_RE,
  clockingEditPage,
  typedKey,
  type ClockingFormValues,
} from './work-locations/clocking/form-fields';
import {
  LOCATION_FIELDS,
  LOCATION_NEW_PAGE,
  clockingPointBase,
  locationEditPage,
  locationSavedHref,
  typedLocationKey,
  type LocationFormValues,
} from './work-locations/location-fields';
import { withQueryParam, workLocationsReturnTo } from '@/lib/return-to';
import { countEmployeesInScope, listEmployeePickOptions } from '@/core/read';
import { ESS_VIEW_COMPONENT_KEYS, type EssViewConfig } from '@/core/ess-view';
import { LEAVE_EXPLANATION_KEYS, type LeaveFormulaConfig } from '@/core/leave-formula';
import { requireAdmin } from '@/lib/authz';
import {
  createGradeGroup,
  updateGradeGroup,
  deleteGradeGroup,
} from '@/core/benefit-scheme';
// r88 1ef1cf95 — shared leave groups are tenant-level now, so their CRUD has its own module rather than
// riding on the benefit-scheme one.
import {
  createLeaveSharedGroup,
  updateLeaveSharedGroup,
  deleteLeaveSharedGroup,
  LeaveTypeAlreadyGroupedError,
  LeaveSharedGroupNameTakenError,
} from '@/core/leave-shared-group';
import { inviteUser, revokeInvitation, setAppUserArchived } from '@/core/auth';
import { setToilPolicy, runToilExpiry, closeReplacementLeaveYear } from '@/core/toil';
import { REPLACEMENT_ELIGIBILITY_CRITERIA, type ReplacementRequestEligibility } from '@/core/replacement-eligibility';
import { setEncashmentPolicy } from '@/core/leave-encashment';
import type { ToilAccrualBasis, ToilExpiryAction, ToilExpiryUnit, ToilReplacementLeaveFrom } from '@/db/schema';
import { upsertCompanyBankProfile, removeCompanyBankProfile, type DisbursementBank } from '@/core/bank-profile';
import { isMyBankKey } from '@/lib/my-banks';
import { isCompanyPanelTab } from '@/lib/company-panel-tabs';
// 65b22c00 — the consolidated General-tab Save. Both contracts live outside this file because a
// `'use server'` module may only export async functions.
import { COMPANY_GENERAL_TAB_SECTION_ORDER } from '@/lib/company-tab-sections';
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD, type TabSaveResult } from '@/lib/tab-save-sections';
import {
  upsertCompanyStatutoryAuthority,
  removeCompanyStatutoryAuthority,
} from '@/core/statutory-authority';
// 15e5bd93 rev 2 (r353) — the controlled set, so the "<body> saved" confirmation resolves the posted
// authority through it rather than echoing a reader-supplied string into a redirect URL.
import { isStatutoryAuthority } from '@/lib/statutory-authorities';
import { packFor } from '@/localization/registry';
// 4e9a4d59 — the post-action redirect contract lives in a plain module so BOTH this file and
// app/admin/leave-approval/actions.ts share ONE okEntitlements (a 'use server' file can only export
// async functions, so these helpers could never be exported from here).
import {
  COMPANY_RULES,
  ENTITLEMENTS,
  GENERATE,
  ORGANIZATION,
  SPECIAL_SETTING,
  SYSTEM_LABELS,
  fail,
  failCompany,
  // 15e5bd93 rev 2 (r353) — the dedicated Statutory Payment Setup screen's own refusal. See the note on
  // `fromStatutorySetupScreen` below for why the destination is chosen per FORM and not per action.
  // rev 4 (r370) — `failStatutoryBody` went with the per-body page: there is one statutory screen again,
  // it holds every body's form, and so it is the screen a refusal belongs on.
  failStatutorySetup,
  ok,
  okCompany,
  okStatutorySetup,
  okToast,
  okEntitlements,
} from './_redirects';

// One path, one owner. `ORGANIZATION` is the constant okCompany/failCompany build on; the short local
// alias is what the ~40 org-catalog actions below have always read, so nothing else in this file moves.
const ORG = ORGANIZATION;

/**
 * 65b22c00 — THE COMPANY PANEL'S OWN TAB, as a CLOSED LIST.
 *
 * components/company-panel.tsx injects its active tab into every form it hosts (the same capture-phase
 * trick components/personnel-tabs.tsx uses, and for the same reason feedback bd2f0bb2 gave: a redirect
 * back to a tab-less URL re-initialises the client tab state to the FIRST tab, so a statutory save that
 * stopped being thrown to the list would instead be thrown to the General tab).
 *
 * Closed list, never the posted string: this value goes into a redirect URL, and echoing an arbitrary
 * one back would be a query-injection hole in the one place a path and a query string meet.
 */
function companyTab(fd: FormData): string {
  const tab = fd.get('tab');
  return isCompanyPanelTab(tab) ? tab : '';
}

/**
 * 65b22c00 — "was this submitted from a company's OWN screen?", as a closed list.
 *
 * Needed by exactly ONE action, and the exception is the point. `archiveCompanyAction` is bound in TWO
 * places: the company panel, and the Archive / Unarchive button on every row of the company LIST
 * (app/admin/organization/page.tsx → components/company-rows.tsx). Repointing the action itself at
 * `/admin/organization/<id>` would have meant archiving a row from the list now opens that company —
 * a regression on a screen this item does not touch. So the destination comes from the FORM.
 *
 * It is an EXPLICIT hidden input in the panel's two archive forms rather than a client-injected marker,
 * so it does not depend on hydration; and it is a fixed value compared against a literal, never a path
 * echoed into a redirect. The other eleven company actions need no marker: the company detail page is
 * their only binding site (pinned by test/organization-stay-on-save.test.ts).
 */
function fromCompanyScreen(fd: FormData): boolean {
  return String(fd.get('returnTo') ?? '') === 'company';
}

/**
 * 15e5bd93 rev 2 (r353) — "was this submitted from the DEDICATED Statutory Payment Setup screen?"
 *
 * The second marker of exactly the shape above, and it exists for the same reason: two actions are now
 * bound in two places. `setCompanyStatutoryAuthorityAction` and `removeCompanyStatutoryAuthorityAction`
 * are reached from the company panel's Statutory tab (where the reader must return to that tab) and from
 * the dedicated Statutory Payment Setup flow (where the reader must stay inside it, which is the reporter's
 * fourth approved point in their own words: "Saving keeps the user on this page… Never redirected to the
 * Organization company list").
 *
 * ⚠️ ONE MARKER FOR ONE FLOW, AND AS OF 15e5bd93 rev 4 (r370) FOR ONE ROUTE AGAIN. r355 split the setup
 * into a LIST of rows (`…/statutory`) and a ONE-BODY screen (`…/statutory/<body>`), and recorded that the
 * marker did not gain a second value for the second route. The reporter contested that per-body page as
 * "an unnecessary intermediate page" and it is deleted: every body is a card on `…/statutory` itself.
 * So success and refusal now want the SAME screen — the one that holds the form — and both call sites
 * below route to it. The marker still means "this came from the statutory payment setup", which is the
 * only fact it ever carried.
 *
 * ⚠️ THE DESTINATION COMES FROM THE FORM, NOT FROM THE ACTION, and repointing the actions instead would
 * have been the wrong fix: the panel's list links into the flow rather than editing in place today, but any
 * future in-panel binding would then land on a screen the reader did not press a button on.
 *
 * A FIXED VALUE COMPARED AGAINST A LITERAL, never a path echoed into a redirect — the one rule
 * `companyTab` above exists to state. Both `okStatutorySetup` and `failStatutorySetup` build their
 * address from `companyId` alone; no posted body reaches a path from this flow any more.
 */
const STATUTORY_SETUP_RETURN = 'statutory-setup';
function fromStatutorySetupScreen(fd: FormData): boolean {
  return String(fd.get('returnTo') ?? '') === STATUTORY_SETUP_RETURN;
}

/**
 * The confirmation the dedicated screen shows, NAMING THE BODY THAT WAS SAVED.
 *
 * The reporter asked for "a confirmation naming what was saved", and on a screen showing eight cards at
 * once a bare "Saved" answers the wrong question — it cannot tell an operator who pressed Save on PTPTN
 * from one who pressed it on EPF. The body's name is the SAME catalogue string the card itself is headed
 * with (`authority_<key>`), so the toast and the card can never call one body two different things.
 *
 * ⚠️ RESOLVED THROUGH THE CONTROLLED SET, never from the posted string. `authority` is reader-supplied
 * and this value goes into a redirect URL; an unrecognised body falls back to the plain "Saved" rather
 * than echoing what was posted or throwing a MISSING_MESSAGE at the reader.
 */
async function statutoryBodySavedToast(authority: string): Promise<string> {
  const t = await getTranslations('admin.organization');
  if (!isStatutoryAuthority(authority)) return t('savedToast');
  return t('authoritySavedToast', { body: t(`authority_${authority}` as never) });
}

/** The session the company writers run under — named once rather than re-spelled at each helper. */
type Session = Awaited<ReturnType<typeof getSession>>;
// a6fe37fc ROUND 5 (cutover) — REPOINTED. This named `/admin/leave`, itself a redirect stub to the leave
// TYPE screen, so a leave-type archive/delete used to land after two hops; the type screen moved to
// `/admin/leave-config/types` in this commit and both stubs now point there, so the constant names the
// screen directly. It is deliberately NOT folded into ENTITLEMENTS: the two differ, and the difference is
// the `#type-<id>` anchor — okEntitlements returns to a SELECTED type, this returns to the list, which is
// the right destination for an action that just archived or deleted the type that was selected.
const LEAVE = '/admin/leave-config/types';
// 4b0e76ae — the managed Leave-Year table and its five create/edit/open/close/delete/opening-rule actions
// are GONE (cc816207 → 1e4eb8af moved that section twice; this item removed it). The one surviving
// leave-year action is openLeaveYearAction, and it redirects to GENERATE, not here. LEAVE remains the
// redirect target of the leave TYPE master actions on /admin/leave.
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';
// 66b8f5a8 — the Holiday Group tab + its dedicated add/edit pages.
const HOLIDAY_GROUPS = '/admin/holidays/groups';
// R33 f21d6eee → af7a8eb4 → e4471e3c (r287) → 6d091cc0 (r301): the per-company attendance policy form has moved
// four times. It lived on /admin/attendance-policy, then /admin/attendance-policy/schedule, then on BOTH that page
// and the Schedule General tab (a `returnTo` closed list picked between them). r301 folded the Work Schedule page
// into the Schedule screen — /admin/attendance-policy/schedule is a redirect stub — so the form has ONE home, the
// Edit panel of Company Policy Settings, and every save returns here. The `ATTENDANCE_POLICY` constant that named
// the old page went with it: a redirect constant naming an address that is no longer a screen is a statement
// about where the screen lives that has stopped being true. Only setAttendancePolicyAction reads this.
//
// ⚠️ A PLAIN PATH, AND IT HAS TO BE. `fail()` and `ok()` build `${path}?error=…` by concatenation, so a path that
// already carries a query string produced '/admin/attendance/schedule?tab=general?error=…' — `tab` read as
// 'general?error=…' and `error` never parsed, so a REFUSED save showed no banner and looked as though it had
// saved (r287 → r301). General is the default tab, so the plain path lands on it. Pinned by
// test/r301-schedule-general.test.ts, which runs the action.
const SCHEDULE_TAB = '/admin/attendance/schedule';
// 296fc027 split this route in two. /admin/toil kept the balance LEDGER and the two settlement sweeps
// (deliberately not entitlement-gated — see core/toil.ts); CONFIGURATION moved to Leave Config.
// 3fb1a611 (r299) — BOTH HALVES ARE ON LEAVE CONFIG › LEAVE CREDIT NOW: the sweeps and the ledger summary on
// its Credits tab (which stays reachable, read-only apart from the sweeps and Reverse, when the `toil`
// entitlement lapses with credits outstanding), the policy on its Rules tab. /admin/toil is a redirect stub.
// The constant keeps its name so the two sweep actions below read as they always did.
const TOIL_POLICY = '/admin/leave-config/leave-credit';
// a6fe37fc ROUND 5 (cutover) — REPOINTED at Company rules, and this is the line that turns three
// banners on that screen from dead markup into live UI. `setToilPolicyAction` returns through here with
// `?saved=`, `?warning=` or `?error=`, and the `warning=` one carries the Phase-B #14 premium-equivalent
// BANKING-RISK warning — produced on every qualifying save for months and silently dropped, because the
// screen it landed on never read the param. Company rules was built reading all three precisely so this
// repoint could not set that up to happen a second time.
//
// 3fb1a611 (r299) — REPOINTED AGAIN, at Leave Credit's Rules tab. The replacement-leave policy left Company
// rules entirely (not re-gated there); the three banners moved with the form, so `?saved=` / `?warning=` /
// `?error=` land on the screen the change was made on.
const LEAVE_REPLACEMENT = '/admin/leave-config/leave-credit/rules';
// 639bf4a5 (r336) — `/admin/locations` is a guarded redirect stub; read from the shared contract so the
// actions cannot land on the old address. rev 2 (r338): the register is Attendance › Locations again and
// the ADDRESS is deliberately unchanged, so this line is too. It is the FALLBACK every whitelisted
// `returnTo` collapses to (lib/return-to.ts workLocationsReturnTo).
const LOCATIONS = LOCATIONS_LIST;

export async function createCompanyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createCompany(s, {
      legalName: String(formData.get('legalName') ?? '').trim(),
      country: String(formData.get('country') ?? 'MY'),
      currency: String(formData.get('currency') ?? 'MYR'),
      registrationNo: (formData.get('registrationNo') as string) || undefined,
      // 3783fd87 — the Company Code, posted from the create form under the SAME field name the General
      // tab's save uses (`companyLabel`, app/admin/actions.ts applyCompanyDetailsSection). One name, one
      // column, one normaliser: there is no second source for this value anywhere.
      companyLabel: String(formData.get('companyLabel') ?? '').trim(),
      // Organization Module (361e3b15): the Default Payroll Cycle picker (pre-set to Monthly). createCompany
      // resolves it against the standard catalog it seeds, defaulting to 'Monthly' for any unknown/blank value.
      defaultPayrollCycle: (formData.get('defaultPayrollCycle') as string) || undefined,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). Change a company's default payroll
 * cycle later from the company's General settings. The core validates the name resolves to an active cycle in
 * that company and audits the before→after change; a successful save confirms via a localised toast.
 */
/**
 * 65b22c00 — the WRITE half, so the per-card action and the General tab's one Save reach the SAME code
 * with the SAME payload. `runCompanyTabSave` hands each section a FormData indistinguishable from what
 * that card would have posted alone, so nothing here can tell which door it came through.
 */
async function applyDefaultCycleSection(s: Session, formData: FormData): Promise<void> {
  await setCompanyDefaultPayrollCycle(s, {
    companyId: String(formData.get('companyId')),
    cycleName: String(formData.get('defaultPayrollCycle') ?? ''),
  });
}

export async function updateCompanyDefaultCycleAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  try {
    await applyDefaultCycleSection(s, formData);
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  // 65b22c00 — the toast is unchanged; where it is SHOWN is not. This was the only save on the screen
  // that already confirmed itself, and it confirmed itself on the list the reader had just been thrown to.
  okCompany(companyId, t('defaultPayrollCycleSaved'), companyTab(formData));
}

/**
 * Derive a TRUSTWORTHY image mime from the file's leading bytes (fail-closed: unknown signature → null). A
 * local 5-line copy — deliberately NOT the claims sniffMime (which trusts PDF) and NOT extracted into a
 * shared module, so the claims path stays byte-identical. PNG + JPEG only; SVG is never accepted (its
 * scriptable payload survives sniffing as a valid image).
 */
function sniffImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export async function setCompanyLogoAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  try {
    const file = formData.get('logo');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a logo image to upload');
    // Check size BEFORE buffering, so a 50 MB upload is rejected without reading it all into memory.
    if (file.size > LOGO_MAX_BYTES) throw new Error('Logo exceeds 2 MB');
    const content = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffImageMime(content);
    if (!mimeType) throw new Error('Only PNG or JPG images are allowed');
    await setCompanyLogo(s, {
      companyId,
      content,
      fileName: file.name,
      mimeType,
      sizeBytes: content.byteLength,
    });
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('savedToast'), companyTab(formData));
}

export async function removeCompanyLogoAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  try {
    await removeCompanyLogo(s, { companyId });
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('removedToast'), companyTab(formData));
}

/** 65b22c00 — see applyDefaultCycleSection. Empty ⇒ null, i.e. "this company is a group root". */
async function applyParentSection(s: Session, formData: FormData): Promise<void> {
  const parent = String(formData.get('parentCompanyId') ?? '');
  await setCompanyParent(s, {
    companyId: String(formData.get('companyId')),
    parentCompanyId: parent || null,
  });
}

export async function setCompanyParentAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  try {
    await applyParentSection(s, formData);
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('savedToast'), companyTab(formData));
}

/**
 * r226 — read a statutory-identity field ONLY if the submitted form actually carried it.
 *
 * This tiny distinction is what lets the identity row be edited from five different forms without one
 * save blanking the others. `undefined` (the key is absent) means "this form does not own that field —
 * leave the stored value alone"; `''` (the key is present and empty) means "the operator cleared it".
 * `(formData.get(k) as string) || undefined` collapses those two into one, which is exactly the bug:
 * under the old full-row writer it blanked four columns, and under the new partial-patch writer it would
 * make a field impossible to CLEAR. See localization/my/company-statutory.ts.
 */
function postedField(formData: FormData, key: string): string | undefined {
  return formData.has(key) ? String(formData.get(key) ?? '') : undefined;
}

/** The HRDF rate as posted, or undefined when the form did not carry the select at all. */
function postedHrdfStatus(formData: FormData): 'not_registered' | 'mandatory' | 'optional' | undefined {
  const raw = String(formData.get('hrdfStatus') ?? '');
  return raw === 'not_registered' || raw === 'mandatory' || raw === 'optional' ? raw : undefined;
}

export async function setCompanyStatutoryAction(formData: FormData) {
  const s = await getSession();
  const country = String(formData.get('country') ?? 'MY');
  const companyId = String(formData.get('companyId'));
  try {
    const pack = packFor(country);
    if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${country}`);
    // Every field is read through postedField, so this action now writes exactly the boxes the form in
    // front of the operator actually had. r226 left only MyInvois + SSM on the Statutory tab's identity
    // list (the rest moved onto their own body's card) — and this action still serves BOTH shapes, which
    // is why it keeps reading all five names rather than shrinking to two.
    await pack.companyStatutory.set(s, {
      companyId,
      epfEmployerNo: postedField(formData, 'epfEmployerNo'),
      socsoEmployerCode: postedField(formData, 'socsoEmployerCode'),
      lhdnEmployerNo: postedField(formData, 'lhdnEmployerNo'),
      myinvoisTin: postedField(formData, 'myinvoisTin'),
      ssmRegistrationNo: postedField(formData, 'ssmRegistrationNo'),
      hrdfStatus: postedHrdfStatus(formData),
    });
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('savedToast'), companyTab(formData));
}

export async function setCompanyBankProfileAction(formData: FormData) {
  const s = await getSession();
  const bank = String(formData.get('bank') ?? '');
  const companyId = String(formData.get('companyId'));
  try {
    // R46 orgbank (84719377): the bank set is the shared Malaysian master (lib/my-banks.ts), not a
    // 4-value enum. The service re-validates — this is the early, friendlier rejection.
    if (!isMyBankKey(bank)) throw new Error('Select a bank from the Malaysian bank list');
    await upsertCompanyBankProfile(s, {
      // Present ⇒ edit that account; absent ⇒ add another (a company may hold several, incl. per bank).
      id: (formData.get('id') as string) || null,
      companyId,
      bank: bank as DisbursementBank,
      corporateId: String(formData.get('corporateId') ?? ''),
      debitAccountNo: String(formData.get('debitAccountNo') ?? ''),
      orgName: (formData.get('orgName') as string) || null,
      // R46: the Payment rail picker is hidden from the form, so this is normally absent and the service
      // keeps the 'IBG' default. The column stays — RENTAS matters for large single payments.
      txnType: (formData.get('txnType') as string) || null,
      accountLabel: (formData.get('accountLabel') as string) || null,
      accountName: (formData.get('accountName') as string) || null,
      accountType: (formData.get('accountType') as string) || null,
      branch: (formData.get('branch') as string) || null,
      swiftCode: (formData.get('swiftCode') as string) || null,
      currency: (formData.get('currency') as string) || null,
      isPrimary: formData.get('isPrimary') === 'on' || formData.get('isPrimary') === 'true',
    });
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('savedToast'), companyTab(formData));
}

export async function removeCompanyBankProfileAction(formData: FormData) {
  const s = await getSession();
  // 65b22c00 — the form posts the ROW id (identity is the row, not the company), so the panel now also
  // carries the company id: without it this action cannot name the screen it was pressed on.
  const companyId = String(formData.get('companyId'));
  try {
    await removeCompanyBankProfile(s, { id: String(formData.get('id')) });
  } catch (e) {
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('removedToast'), companyTab(formData));
}

// R46 orgbank (84719377) — per-authority statutory payment configuration. One form per authority; the
// service validates the authority code, that the chosen bank account belongs to this company, and that a
// NEWLY chosen signatory is an active employee of it.
export async function setCompanyStatutoryAuthorityAction(formData: FormData) {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  try {
    await upsertCompanyStatutoryAuthority(s, {
      companyId,
      authority: String(formData.get('authority') ?? ''),
      accountNo: (formData.get('accountNo') as string) || null,
      bankProfileId: (formData.get('bankProfileId') as string) || null,
      addressLine1: (formData.get('addressLine1') as string) || null,
      addressLine2: (formData.get('addressLine2') as string) || null,
      addressLine3: (formData.get('addressLine3') as string) || null,
      city: (formData.get('city') as string) || null,
      state: (formData.get('state') as string) || null,
      postcode: (formData.get('postcode') as string) || null,
      country: (formData.get('country') as string) || null,
      phone: (formData.get('phone') as string) || null,
      email: (formData.get('email') as string) || null,
      signatoryPersonId: (formData.get('signatoryPersonId') as string) || null,
    });

    // r226 — the card is ONE body, so it saves with ONE button, and that means this action writes the
    // body's two halves into their two tables: the payment setup above (company_statutory_authority) and
    // the number that goes on the body's FILED FORM below (company_statutory_my, via the country pack).
    //
    // `filingCountry` is a hidden input the card renders only when it actually has a filing field, and it
    // is deliberately NOT called `country` — that name is already taken on this form by the authority's
    // postal address. Nothing is written unless the form carried a filing field, and the identity write
    // is a PARTIAL PATCH, so saving the EPF card cannot touch SOCSO's, LHDN's, MyInvois's or SSM's number.
    const filingCountry = String(formData.get('filingCountry') ?? '');
    const filing = {
      epfEmployerNo: postedField(formData, 'epfEmployerNo'),
      socsoEmployerCode: postedField(formData, 'socsoEmployerCode'),
      lhdnEmployerNo: postedField(formData, 'lhdnEmployerNo'),
      hrdfStatus: postedHrdfStatus(formData),
    };
    if (filingCountry && Object.values(filing).some((v) => v !== undefined)) {
      const pack = packFor(filingCountry);
      if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${filingCountry}`);
      await pack.companyStatutory.set(s, { companyId, ...filing });
    }
  } catch (e) {
    // 15e5bd93 rev 2 (r353) — a refusal returns to the screen that holds the form, never to the company
    // panel: `failCompany` would have shown "Choose a signatory who is an active employee of this company"
    // on a page with no such box on it.
    //
    // ⚠️ REV 4 (r370) — AND THE SCREEN THAT HOLDS THE FORM IS `…/statutory` ITSELF AGAIN. r355 sent this
    // refusal to `…/statutory/<body>?mode=edit` because that was the only page with the boxes on it; the
    // reporter contested that page and it is deleted. Every body's form is on the one statutory screen
    // now, so the rule is satisfied by the simpler address and no posted body reaches a path.
    if (fromStatutorySetupScreen(formData)) failStatutorySetup(e, companyId);
    failCompany(e, companyId, companyTab(formData));
  }
  // 15e5bd93 rev 2 — "Saving keeps the user on this page and shows a confirmation naming what was saved."
  // rev 4 — the page it keeps you on is the one statutory screen. This action is no longer the screen's
  // Save (that is `saveCompanyStatutoryTabAction`, which returns rather than redirects); it is still
  // bound to every body's form, because a form with no action POSTs to the current URL, and it is what
  // a browser with the bundle blocked would reach. The confirmation still NAMES the body, and on a
  // screen showing eight cards a bare "Saved" cannot say which one took.
  if (fromStatutorySetupScreen(formData)) {
    okStatutorySetup(companyId, await statutoryBodySavedToast(String(formData.get('authority') ?? '')));
  }
  const t = await getTranslations('admin.organization');
  okCompany(companyId, t('savedToast'), companyTab(formData));
}

export async function removeCompanyStatutoryAuthorityAction(formData: FormData) {
  const s = await getSession();
  // As with the bank profile above: the form posts the ROW id, so the company id rides alongside it.
  const companyId = String(formData.get('companyId'));
  try {
    await removeCompanyStatutoryAuthority(s, { id: String(formData.get('id')) });
  } catch (e) {
    // 15e5bd93 rev 4 (r370) — same as the save above: a refused Clear lands back on the statutory screen,
    // which is where the button was pressed and where the body's card still is. r355 sent it to the
    // per-body page; that page is deleted.
    if (fromStatutorySetupScreen(formData)) failStatutorySetup(e, companyId);
    failCompany(e, companyId, companyTab(formData));
  }
  const t = await getTranslations('admin.organization');
  // 15e5bd93 rev 2 — Clear is the one control on the setup screen that is NOT a field edit: it DELETES
  // the body's row, so it stays outside the screen-wide Save (bucket (b)). rev 4 — a SUCCESSFUL clear
  // returns to the statutory screen, where the body's card now reads "Not set up", which is the visible
  // proof the clear took. It keeps the generic "Removed": naming a body that no longer has a record
  // would read as a confirmation that it was saved.
  if (fromStatutorySetupScreen(formData)) okStatutorySetup(companyId, t('removedToast'));
  okCompany(companyId, t('removedToast'), companyTab(formData));
}

export async function createDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await createDepartment(s, {
      companyId: String(formData.get('companyId')),
      name: String(formData.get('name') ?? '').trim(),
      // Empty string = "— None —" → unassigned (the service treats blank as null).
      businessUnitId: String(formData.get('businessUnitId') ?? '').trim() || null,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function updateDepartmentAction(formData: FormData) {
  const s = await getSession();
  // businessUnitId is present on the edit row (a select). Empty string clears the link; a value sets it.
  // If the field is absent entirely (undefined), leave the BU untouched (tri-state in the service).
  const buRaw = formData.get('businessUnitId');
  // 6fadb036: headEmploymentId is present on the edit row (a select). Absent field ⇒ untouched; empty ⇒ clear.
  const headRaw = formData.get('headEmploymentId');
  try {
    await updateDepartment(s, {
      id: String(formData.get('id')),
      name: String(formData.get('name') ?? '').trim(),
      businessUnitId: buRaw === null ? undefined : String(buRaw).trim() || null,
      headEmploymentId: headRaw === null ? undefined : String(headRaw).trim() || null,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function archiveDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveDepartment(s, {
      id: String(formData.get('id')),
      archived: formData.get('archived') === 'true',
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function deleteDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteDepartment(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createPositionAction(formData: FormData) {
  const s = await getSession();
  try {
    await createPosition(s, {
      companyId: String(formData.get('companyId')),
      title: String(formData.get('title') ?? '').trim(),
      jobFamily: (formData.get('jobFamily') as string) || undefined,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createCostCenterAction(formData: FormData) {
  const s = await getSession();
  try {
    await createCostCenter(s, {
      companyId: String(formData.get('companyId')),
      code: String(formData.get('code') ?? '').trim(),
      name: String(formData.get('name') ?? '').trim(),
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createLeaveTypeAction(formData: FormData) {
  const s = await getSession();
  let created: { id: string };
  try {
    created = await createLeaveType(s, {
      code: String(formData.get('code') ?? '').trim().toUpperCase(),
      name: String(formData.get('name') ?? '').trim(),
      paid: formData.get('paid') === 'on',
      // Leave Type master page (feedback 097de541): the add-type form now carries an optional Description and
      // a Status select (active|inactive, default active). The service trims the description (empty ⇒ null).
      description: String(formData.get('description') ?? '').trim(),
      active: formData.get('active') !== 'inactive',
      // Leave Unit Configuration (e4980382): the add-type form carries a Day/Hour select beside "Paid".
      // Anything other than 'hour' falls back to 'day' (default), so an absent field ⇒ Day.
      leaveUnit: formData.get('leaveUnit') === 'hour' ? 'hour' : 'day',
    });
  } catch (e) {
    // 8cc268c4: the add form lives in the Entitlements workspace's "Add Leave Type" dialog now, so both
    // outcomes land back on the Entitlements tab (the old ok/fail(LEAVE) pointed at the read-only Types tab).
    // The ?error= banner is mirrored inside the still-open dialog by the page.
    fail(ENTITLEMENTS, e);
  }
  // Success: carry the stay-on-save #type-<id> anchor (the 097de541 deep-link contract) so the workspace
  // selects the just-created type and closes the add dialog.
  revalidatePath(ENTITLEMENTS);
  redirect(`${ENTITLEMENTS}#type-${created.id}`);
}

/** ADR-0038 carry-forward expiry: an empty month/day field means "no expiry" → null. */
const carryExpiryField = (raw: FormDataEntryValue | null): number | null => {
  const n = Number(raw ?? '');
  return raw != null && String(raw) !== '' && Number.isFinite(n) ? n : null;
};

/** R4 Build #1: read the carry-expiry mode from the form, constrained to the two valid values (default
 *  'date' for back-compat when the field is absent). The 1..12 months range is validated in core/admin.ts. */
const carryExpiryMode = (fd: FormData): 'date' | 'months' =>
  fd.get('carryForwardExpiryMode') === 'months' ? 'months' : 'date';

/**
 * Carry-forward enhancement — only send a carry boolean when the carry block was actually rendered for
 * this policy (the ANNUAL-only block emits a hidden `carryBlockRendered=1` marker). With the marker we
 * map an unchecked checkbox to `false`; WITHOUT it we return undefined so the service omits the key and
 * the back-compat `carryForwardMax > 0` default is preserved — preventing a non-ANNUAL edit (which never
 * renders the block) from silently flipping carry off. */
const carryFlagField = (fd: FormData, name: string): boolean | undefined =>
  fd.get('carryBlockRendered') == null ? undefined : fd.get(name) === 'on';

/**
 * Feedback b81d3c52 — Rounding Method (Entitlements → leave type → General → Earning Method). TRI-STATE
 * (this ticket), mirroring `serviceBandsField` exactly, so the Rounding Method REMEMBERS itself on its own
 * instead of riding a hidden input on every unrelated form (the footgun the codebase itself flagged):
 *  - marker `roundingMethodRendered` ABSENT ⇒ `undefined` = PRESERVE (the form did not render the Rounding
 *    dropdown — Carry Forward / Eligibility inline edit — so the writer keeps the stored value);
 *  - marker present + a choosable method ⇒ that value = SET;
 *  - marker present + anything else (incl. 'none') ⇒ `null` = explicit CLEAR (omit the key).
 * Only the form that actually renders the dropdown (Earning Method) posts the marker.
 *
 * 8fec719e narrowed the accepted set to the TWO the reporter now has: 'custom' = SET, anything else
 * (including 'none' and the three retired methods) = CLEAR. The add-entitlement form no longer renders a
 * rounding control at all, so the JSONB surface has no writer left — rounding is a leave-TYPE rule.
 */
const roundingMethodField = (fd: FormData): 'custom' | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const v = String(fd.get('roundingMethod') ?? '');
  return v === 'custom' ? 'custom' : null;
};

/**
 * 8fec719e — the custom rounding table, posted as ONE JSON field and riding the SAME
 * `roundingMethodRendered` marker as the dropdown it belongs to (the `roundingThresholdField` precedent
 * directly below, for the same reason: the table is part of the rounding configuration, not a setting
 * that outlives it).
 *
 * Marker present + rows ⇒ the parsed array. Marker present + blank / `[]` ⇒ null = CLEAR. Marker absent ⇒
 * undefined = PRESERVE.
 *
 * A MALFORMED JSON STRING IS `undefined`, NOT `null` — the `serviceBandsField` precedent verbatim: a
 * client-side bug must not silently wipe a table an administrator spent time building. A table that DOES
 * parse but is self-contradictory is a different case and is refused loudly by `setLeaveTypeRules`.
 */
const roundingBandsField = (fd: FormData): RoundingBand[] | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const raw = fd.get('roundingBands');
  if (raw == null || String(raw) === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.length === 0 ? null : (parsed as RoundingBand[]);
  } catch {
    return undefined;
  }
};

/**
 * 845903a3 (r313) — the ENTITLEMENT rounding rule, the exact twin of the two parsers above with its OWN
 * marker (`entitlementRoundingMethodRendered`). A separate marker is not tidiness: the two rules are
 * rendered by the same form today, but a form that renders one and not the other must preserve the one
 * it did not show, and sharing a marker would silently clear it. That is the tri-state footgun
 * `roundingMethodField`'s own header describes.
 *
 * A malformed JSON string is `undefined` (PRESERVE), never `null` (CLEAR) — the serviceBandsField
 * precedent, for the same reason: a client-side bug must not wipe a table somebody spent time building.
 */
const entitlementRoundingMethodField = (fd: FormData): 'custom' | null | undefined => {
  if (fd.get('entitlementRoundingMethodRendered') == null) return undefined;
  return String(fd.get('entitlementRoundingMethod') ?? '') === 'custom' ? 'custom' : null;
};

const entitlementRoundingBandsField = (fd: FormData): RoundingBand[] | null | undefined => {
  if (fd.get('entitlementRoundingMethodRendered') == null) return undefined;
  const raw = fd.get('entitlementRoundingBands');
  if (raw == null || String(raw) === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.length === 0 ? null : (parsed as RoundingBand[]);
  } catch {
    return undefined;
  }
};

/**
 * Feedback 9f5164d8 — the custom decimal threshold, riding the SAME `roundingMethodRendered` marker as the
 * dropdown it belongs to. It is not a second tri-state: the threshold is part of the rounding
 * configuration, so a form that does not render the rounding control preserves both, and a form that does
 * render it decides both together.
 *
 * Marker present + a parseable number ⇒ SET. Marker present + blank / unparseable ⇒ null = CLEAR, which is
 * exactly what "Customize decimal thresholds" being unticked means: use the standard rule. The bounds are
 * NOT enforced here — `setLeaveTypeRules` throws a readable, localizable error for an out-of-range value,
 * and silently swallowing it here would let a typo save as "standard rule" without telling anyone.
 */
const roundingThresholdField = (fd: FormData): number | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const raw = String(fd.get('roundingThreshold') ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Leave Entitlement Rules Engine — the band editor always renders a hidden `serviceBandsRendered=1` marker
 * plus a `serviceBands` JSON field (exact carryBlockRendered/carryFlagField precedent above). Marker absent
 * ⇒ undefined (preserve on update; no-op on create). Marker present + empty array ⇒ null (clear). Marker
 * present + rows ⇒ the parsed array (service validates the shape). A malformed JSON string is treated as
 * undefined (preserve) so a client-side bug can't accidentally wipe existing bands — the replace path's own
 * validation catches a genuinely bad shape that DOES parse.
 */
const serviceBandsField = (fd: FormData): ServiceBand[] | null | undefined => {
  if (fd.get('serviceBandsRendered') == null) return undefined;
  const raw = fd.get('serviceBands');
  if (raw == null || String(raw) === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return undefined;
    if (parsed.length === 0) return null;
    return parsed as ServiceBand[];
  } catch {
    return undefined; // malformed JSON ⇒ preserve rather than silently clear
  }
};


/**
 * Feedback 9d8cf621 — "Employee Selection" fan-out. The add-entitlement form now offers MULTI-select
 * companies + grades (removable chips). On save we create one leave_policy per (company × grade) combination
 * so a single HR action can scope one entitlement to several companies/grades at once. An empty companies
 * axis ⇒ [null] (group default / all companies); an empty grades axis ⇒ [null] (all grades) — i.e. today's
 * single group-default row when nothing is selected. Each createLeavePolicy appends its OWN
 * `leave-policy.created` DomainEvent (substrate discipline — one event per created row, correct by
 * construction). The band editor's per-range Carry-Forward Days / Carry-Forward Expiry / Maximum Balance Days
 * ride the serviceBands JSON untouched.
 */

/**
 * Feedback 9d8cf621 — live "entitled employees" count next to the Employee-Selection chips. READ-ONLY
 * (no DomainEvent). Returns the number of active employees the currently-selected companies/grades cover.
 */
export async function countEmployeesInScopeAction(p: {
  companyIds: string[];
  gradeIds: string[];
}): Promise<number> {
  const s = await getSession();
  return countEmployeesInScope(s, { companyIds: p.companyIds, gradeIds: p.gradeIds });
}

/**
 * THE TYPE-LEVEL RULE EDITOR (9816a5ad step 2). Writes the five consolidated settings to the leave TYPE.
 *
 * This replaces what the Earning Method and Carry Forward Policy sub-steps used to do. They were "front
 * doors" onto a per-company/grade `leave_policy` row; once step 2 repoints the engines at `leave_type`,
 * writing a policy row changes nothing the calculation reads — a form that saves successfully and has no
 * effect, which is worse than no form at all.
 *
 * TRI-STATE, PER SUB-FORM. Earning Method and Carry Forward are separate forms editing disjoint halves of
 * one row, so each posts a marker naming the half it rendered and only that half is forwarded. Without
 * that, an earning-only save would clear the carry configuration. The old front doors solved this by
 * re-posting the other half as hidden inputs; markers are the same idea without the footgun of a stale
 * hidden value overwriting a concurrent edit.
 */
export async function setLeaveTypeRulesAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('admin');
  const id = String(formData.get('leaveTypeId') ?? '');
  const num = (name: string): number | null | undefined => {
    if (formData.get(name) == null) return undefined;
    const raw = String(formData.get(name) ?? '');
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const earningRendered = formData.get('earningRendered') != null;
  const carryRendered = formData.get('carryBlockRendered') != null;
  // r299 (3de1453a) — "This is our Annual Leave", on its OWN marker. The Earning Method form renders the
  // switch only where the administrator may change it; where it is locked (another type already is Annual
  // Leave, the type is classified as something else, or it is Annual Leave by its code) it posts NO marker,
  // so the role is untouched. The value is a hidden '1' / '0' rather than a checkbox's presence, because a
  // switch the form disables while an earned method is chosen would otherwise post nothing and read as OFF.
  const annualLeaveRendered = formData.get('annualLeaveRendered') != null;

  let saved = { unconfiguredCleared: false };
  try {
    saved = (await setLeaveTypeRules(s, {
      id,
      ...(annualLeaveRendered ? { isAnnualLeave: formData.get('isAnnualLeave') === '1' } : {}),
      // Earning half — method + rounding. roundingMethodField already carries its own tri-state marker.
      ...(earningRendered
        ? {
            accrualMethod: String(formData.get('method') ?? '') || null,
            // bc36c768 — the accrual day rides the earningRendered marker, like the method it belongs to.
            // `num` returns undefined when the FIELD IS ABSENT, and the editor renders it only for Monthly
            // Accrual — so `?? null` deliberately CLEARS the stored day whenever the earning form saves
            // any other choice. That is the intent: a credit day that belongs to a cadence this type no
            // longer uses must not linger, waiting to surprise whoever switches back to monthly.
            accrualDay: num('accrualDay') ?? null,
            // NOT `?? null`. roundingMethodField already carries its own tri-state: undefined means the
            // dropdown was not rendered, which the service reads as PRESERVE. Coercing that to null would
            // clear the stored rounding for any form that ever stops rendering the control.
            roundingMethod: roundingMethodField(formData),
            // 9f5164d8 — the threshold rides the same marker as the dropdown, for the same reason and with
            // the same NOT-`?? null` discipline. 8fec719e retired 'nearest_half' as a choice, so the editor
            // no longer renders the field and this now reads as a CLEAR whenever the rounding form saves —
            // deliberately: a threshold that belongs to a method nobody can pick must not linger.
            roundingThreshold: roundingThresholdField(formData),
            // 8fec719e — the custom rounding table, on the SAME marker as the method it belongs to.
            roundingBands: roundingBandsField(formData),
          }
        : {}),
      // 845903a3 (r313) — the ENTITLEMENT rounding rule, on its OWN marker rather than inside the
      // `earningRendered` block above. It is rendered by the same form today, but the two are separate
      // purposes and a form that ever renders one without the other must preserve the one it did not
      // show. Reading its own marker is what makes that true by construction instead of by arrangement.
      entitlementRoundingMethod: entitlementRoundingMethodField(formData),
      entitlementRoundingBands: entitlementRoundingBandsField(formData),
      // Carry half — enable flag, cap, expiry mode and both expiry shapes, plus the max-balance cap.
      ...(carryRendered
        ? {
            carryForwardEnabled: formData.get('carryForwardEnabled') === 'on',
            carryForwardMax: num('carryForwardMax') ?? null,
            // 7cd914b1 — an EMPTY string posts as null, which CLEARS the percentage. That is deliberate:
            // Fixed Maximum and None both post it empty, so a stored percentage cannot survive a switch
            // away from percentage mode and quietly keep winning the resolution.
            carryForwardPercent: num('carryForwardPercent') ?? null,
            carryForwardExpiryMode: carryExpiryMode(formData),
            carryForwardExpiryMonths: carryExpiryField(formData.get('carryForwardExpiryMonths')),
            carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
            carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
            carryForwardIncludeEarned: formData.get('carryForwardIncludeEarned') === 'on',
            maxBalanceDays: num('maxBalanceDays'),
          }
        : {}),
    })) ?? { unconfiguredCleared: false };
  } catch (e) {
    // r303 (05db6aa7) — the ERROR, not its message. `fail()` reads `.message` off what it is given, so passing
    // the string put `?error=undefined` in the URL and every refusal of this form (the rounding table's
    // row-by-row sentences included) reached the operator as the word "undefined".
    if (e instanceof LeaveTypeRuleError) return fail(ENTITLEMENTS, e);
    throw e;
  }
  // bc36c768 — THE CATCH-UP, AFTER THE CONFIG WRITE HAS COMMITTED, never inside it.
  //
  // This is the moment balances move, and it is the promise the NOT-CONFIGURED state is made of: an
  // employee hired while the type was unconfigured was credited +0.00 and lost nothing, because saving
  // the earning method credits everything owed as a single upward top-up, here and now. Without this the
  // under-credit would sit there indefinitely, waiting for some unrelated profile edit to fix it.
  //
  // ORDERING IS LOAD-BEARING, not stylistic: each per-employee recalc inside the cohort opens its OWN
  // transaction and reads the COMMITTED rules. Calling it inside setLeaveTypeRules would have every
  // employee reproject against the configuration this save just replaced. A test asserts the ordering.
  //
  // Best-effort, exactly like the scheme-cohort precedent at upsertSchemeEntitlementAction: the
  // configuration is saved and must stay saved; the recalc is idempotent and self-heals on the next
  // trigger, so a failure here must not turn a successful save into an error banner.
  if (saved.unconfiguredCleared) {
    try {
      await reprojectEntitlementForLeaveTypeCohort(s, { leaveTypeId: id, trigger: 'leave_type_rules' });
    } catch (e) {
      console.error(`leave-type cohort catch-up failed for leave type ${id}:`, e);
    }
  }
  // r299 render check — the key lives at admin.leave.entitlementUpdatedToast; `t` here is the `admin`
  // namespace, so the bare key threw MISSING_MESSAGE on every earning / carry save and the toast showed the
  // raw key path (pre-existing on main@60a40452, found by rendering the Annual Leave switch save).
  okEntitlements(t('leave.entitlementUpdatedToast'), id);
}


/**
 * Restructure Service-Based Leave Entitlements — save one grade's three service-band figures for a company
 * from the company-driven Service Based Entitlements table. The first save for a company materialises the
 * whole company scope so the untouched grades never silently drop to zero (ADR-0066 short-circuit); the
 * edited grade is recalculated in place. Everything is orchestrated over the existing createLeavePolicy /
 * updateLeavePolicy writers in core (no new writer primitive) — see saveServiceEntitlement.
 *
 * 9816a5ad UNMOUNTED it: Service Based Entitlements maintains BENEFIT SCHEMES now, so no screen posts here.
 * Kept rather than deleted because it is the only writer that materialises a company's whole grade scope on
 * first save — the ADR-0066 short-circuit guard test/service-based-entitlement.test.ts pins — and grade-level
 * policies still resolve for anyone no scheme covers. Delete it together with core/saveServiceEntitlement if
 * a later round retires grade-level entitlement outright.
 */


/** feedback 2c7c6385 (Run Earned Accrual button): the scope the HR admin picked in the review card. An
 *  empty array on any axis ⇒ "all" on that axis (matches countEmployeesInScope). `year` selects the leave
 *  year → asOf (asOfForLeaveYear: current=to-date, past/future=full cycle). */
export type EarnedAccrualScope = {
  year: number;
  companyIds: string[];
  gradeIds: string[];
  leaveTypeIds: string[];
};

/**
 * feedback 2c7c6385 — PREVIEW (dry-run) for the "Run Earned Accrual" review card. Computes the EXACT same
 * grouped breakdown a real run would, WITHOUT writing anything (no ledger rows, no audit event). RLS scopes
 * the underlying reads to the session's visible companies, so a group admin cannot preview outside their
 * companies even if they hand-craft a companyId. READ-ONLY (the dryRun engine appends no event).
 */
export async function previewEarnedAccrualAction(
  scope: EarnedAccrualScope,
): Promise<{ rows?: EarnedAccrualGroup[]; asOf?: string; error?: string }> {
  // r301 (parent hand-fix) — requireAdmin, not getSession: the page is admin-only but a server action is its own
  // endpoint, and accrueEarnedLeave carries no admin check. The same hole 4b0e76ae closed on openLeaveYearAction.
  const s = await requireAdmin();
  try {
    const asOf = asOfForLeaveYear(scope.year, todayInKualaLumpur());
    const { breakdown } = await accrueEarnedLeave(s, {
      asOf,
      companyIds: scope.companyIds,
      gradeIds: scope.gradeIds,
      leaveTypeIds: scope.leaveTypeIds,
      dryRun: true,
    });
    return { rows: breakdown, asOf };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** ADR-0040 (2D-1) + feedback 2c7c6385: top earned policies up to the accrued amount for the selected leave
 *  year, narrowed to the chosen scope. Idempotent — admins can run it any time; a re-run grants nothing more
 *  (the monthly cron scripts/accrue-earned.ts calls the same engine unscoped). Returns {granted, forfeits}
 *  so the review card can surface "N generated" (a 2nd run visibly shows 0). No redirect — the client card
 *  toasts + refreshes — the pattern grantAdHocLeaveAction used before 38f1fd40 retired it. */
export async function runEarnedAccrualAction(
  scope: EarnedAccrualScope,
): Promise<{ granted?: number; forfeits?: number; error?: string }> {
  const s = await requireAdmin();
  try {
    const asOf = asOfForLeaveYear(scope.year, todayInKualaLumpur());
    const { granted, forfeits } = await accrueEarnedLeave(s, {
      asOf,
      companyIds: scope.companyIds,
      gradeIds: scope.gradeIds,
      leaveTypeIds: scope.leaveTypeIds,
    });
    revalidatePath(LEAVE);
    revalidatePath(ENTITLEMENTS);
    return { granted, forfeits };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// 1e4eb8af — setCompanyLeaveCycleAction is GONE with the Application Rules tab that hosted its only form.
// The per-COMPANY calendar-vs-anniversary card was a second place to decide the same thing the per-TYPE
// Leave Year Type override decides (Custom Settings → Leave Year Configuration), and that override's three
// explicit choices (a2a / a2c / c2c) cover every shape the company card offered. Nothing posts the action
// any more, so it is removed rather than left dangling; core/admin.setCompanyLeaveCycle is UNCHANGED and
// still the write path — stored company cycles keep driving types left on "Company default".

/** Feedback request 31474452 / R64 08bc6841: the half-day-deduction toggle, one company per post.
 *  RETIRED BY 10e96227 — the card is now ONE multi-select plus ONE Save, so nothing posts a single
 *  company any more and the action is removed rather than left dangling (the r100
 *  saveLeaveApprovalPolicyAction precedent: a server action retires WITH the screen that was its only
 *  caller). `core/admin.setLeaveHalfDayFullDeduction` is UNCHANGED and deliberately kept — it is the
 *  single-company primitive the behavioural tests drive directly; only its form wrapper is gone.
 *  Replaced by setLeaveHalfDayFullDeductionCompaniesAction below. */

/**
 * 10e96227 — the half-day-deduction card saves the WHOLE company set in one post.
 *
 * The reporter's complaint was arithmetic: eight companies meant eight rows and eight Saves to express
 * one decision. The multi-select posts every selected company under the same `companyIds` field (the
 * house convention — cf. the festive-grant company picker above), so the whole rule arrives as one
 * statement of intent and the core write turns the ones NOT posted off.
 *
 * `getAll` with no selection yields `[]`, which is a MEANINGFUL value here, not a missing one: it means
 * "applies nowhere", the same thing every box unticked meant before. That is why there is no guard
 * rejecting an empty post — treating empty as "nothing to do" would make it impossible to turn the last
 * company off, which is exactly the state the old per-row UI could reach trivially.
 */
export async function setLeaveHalfDayFullDeductionCompaniesAction(formData: FormData) {
  const s = await getSession();
  try {
    await setLeaveHalfDayFullDeductionCompanies(s, {
      companyIds: formData.getAll('companyIds').map(String).filter(Boolean),
    });
  } catch (e) {
    // a6fe37fc ROUND 5 (cutover) — RETURNS TO WHERE THE CARD IS, not to the leave type screen. This is a
    // COMPANY decision that used to be drawn once per leave type on the Leave types page; returning to
    // ENTITLEMENTS would drop the administrator on a screen that no longer shows the setting they just
    // changed — and, on the error path, would show a message about a form they can no longer see.
    // r281 (a73d1e14) — SPECIAL_SETTING, not COMPANY_RULES. The card moved to a heading of its own (the
    // reporter's "Special Setting" row) and the return address moves WITH it, for exactly the reason it
    // moved off ENTITLEMENTS in the first place.
    fail(SPECIAL_SETTING, e);
  }
  ok(SPECIAL_SETTING);
}

// b1b81a08 — createJobGradeAction / updateJobGradeAction / archiveJobGradeAction / deleteJobGradeAction and
// their gradeReturnAnchor helper are GONE. Grade master data is no longer maintained from Leave Config, so
// there is no leave-type panel to return to: the grid on Settings → System Labels → Organisation Labels
// calls saveJobGradesGridAction / removeJobGradeGridAction (app/admin/settings/actions.ts), which are
// value-returning (per-row errors) rather than redirecting, and which gate on requireAdmin. The core
// mutations in core/admin.ts are unchanged and are what both surfaces have always called.


// ── Public holidays ──
/** Preserve the active country/year/group filter across the redirect so the admin stays in context.
 *  (R18 a519a96e: `group` keeps the per-group effective-calendar view open across row edits.)
 *
 *  9da61c86 — and the PAGE with them. The list pages now, and every row's Save and Delete post through
 *  here; without the page in the redirect, editing the third holiday on page 4 drops the admin back on
 *  page 1 and they have to find their place again. The page rides as `filterPage` / `filterSize` for the
 *  same reason country and year do: a server action reads the form, never the address it was posted
 *  from. The page's hidden fields are the other half of this contract — neither half works alone. */
function holidaysPath(
  formData: FormData,
  /** Where the row the admin just touched actually IS — see holidayFollowPath. */
  over: { country?: string; year?: string; page?: number } = {},
): string {
  const sp = new URLSearchParams();
  const country = over.country ?? String(formData.get('filterCountry') ?? '').trim();
  const year = over.year ?? String(formData.get('filterYear') ?? '').trim();
  const group = String(formData.get('filterGroup') ?? '').trim();
  const page = over.page !== undefined ? String(over.page) : String(formData.get('filterPage') ?? '').trim();
  const size = String(formData.get('filterSize') ?? '').trim();
  if (country) sp.set('country', country);
  if (year) sp.set('year', year);
  if (group) sp.set('group', group);
  // page 0 is the bare screen, so it is written only when it is not the first page — the same rule the
  // pager's own links follow.
  if (page && page !== '0') sp.set('page', page);
  // The size is written only when the READER chose one. The hidden field always carries the resolved
  // default, so echoing it unconditionally turned a bare /admin/holidays into ?size=25 on the first Save —
  // an address that says a choice was made when none was, and (on the client pager's rule) an arrival that
  // is no longer bare. The page therefore posts filterSize only when the address already carries a size.
  if (size) sp.set('size', size);
  const qs = sp.toString();
  return qs ? `${HOLIDAYS}?${qs}` : HOLIDAYS;
}

/**
 * The address that PUTS THE ROW THE ADMIN JUST SAVED IN FRONT OF THEM (9da61c86 fix pass).
 *
 * holidaysPath alone returns you to the page you posted from, which is right for a Save that changes a
 * name and wrong for the two writes that MOVE a row. The master is ordered by date and now sliced at 25:
 * add a holiday for next year from page 1 and it lands on the last page, edit a date and the row jumps
 * pages. Both looked like "the product did nothing" — the reporter's Add New requirement is that "the new
 * record should be reflected in the list automatically", and a success toast over an unchanged table is
 * the opposite of that.
 *
 * So the row is looked up in the SAME list the screen builds (core listHolidays under the same filter,
 * same order) and its index becomes the page. Two consequences worth stating:
 *   · A FILTER THAT EXCLUDES THE ROW IS DROPPED, because no page number can show a row the filter hides.
 *     Only the filter that actually excludes it: adding a 2027 holiday while filtered to 2026 clears the
 *     year and keeps the country.
 *   · The lookup costs one extra query per create/edit — a list this screen already runs on every render.
 * A row that cannot be found at all (deleted from another tab between the write and the read) answers
 * page one rather than a negative page, exactly as pageOfIndex does for the client grids.
 */
async function holidayFollowPath(
  s: Awaited<ReturnType<typeof getSession>>,
  formData: FormData,
  id: string,
  /** The row's country — omitted by update, where scope is immutable and cannot leave the filter. */
  rowCountry: string | undefined,
  /** The row's date as posted (YYYY-MM-DD); its year is what the year filter is checked against. */
  rowDate: string,
): Promise<string> {
  const filterCountry = String(formData.get('filterCountry') ?? '').trim();
  const filterYear = String(formData.get('filterYear') ?? '').trim();
  const size = parsePageSize(String(formData.get('filterSize') ?? '') || undefined);
  const rowYear = /^(\d{4})-/.exec(rowDate)?.[1] ?? '';
  const country = rowCountry && filterCountry && filterCountry !== rowCountry ? '' : filterCountry;
  const year = rowYear && filterYear && filterYear !== rowYear ? '' : filterYear;
  const rows = await listHolidays(s, {
    country: country || undefined,
    year: year ? Number(year) : undefined,
  });
  const page = pageOfIndex(
    rows.findIndex((r) => r.id === id),
    size,
  );
  return holidaysPath(formData, { country, year, page });
}

/** What a holiday save tells the dialog (def44f29). Returned, never redirected — see saveHolidayAction. */
export type HolidaySaveResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * def44f29 — Add or Edit a holiday from the dialog over the list (app/admin/holidays/holiday-dialog.tsx).
 * One action for both: no `id` posted means an insert, an `id` means an update of that row. It REPLACED
 * createHolidayAction + updateHolidayAction, which redirected — the shape the movement-type dialog
 * (1b87e8a0) retired for the same reason: a redirect navigates the route out from under an open dialog,
 * and on a REFUSAL (a duplicate date, a state the pack does not know, a scope the row cannot take) it
 * would close the dialog and throw away everything the admin had typed. Returning `{ ok: false, error }`
 * keeps the dialog open with the typing intact and paints the reason inside it.
 *
 * ON SUCCESS THE PATH COMES BACK instead of being redirected to, and the island navigates there itself.
 * It is the same holidayFollowPath the redirect used to carry (9da61c86: land on the page that SHOWS the
 * row, dropping only a filter that would hide it), so adding next year's holiday from page 1 still puts
 * the new row in front of the admin. The hidden filter fields (filterCountry / filterYear / filterPage /
 * filterSize) travel inside the dialog's form for that reason — holidaysPath reads them from formData.
 *
 * NATIONAL / STATE. `state` posted as '' means national; a state label means that state. NOT POSTED AT ALL
 * means "leave it alone": the edit dialog omits the field on a business-group / holiday-group row, whose
 * scope is fixed — and updateHoliday refuses a change on such a row independently, so a forged field
 * cannot get past this presence check. On an insert an absent field is simply national.
 *
 * 66b8f5a8 / 3e831868 — Holiday Code + Description are not collected: omitting them makes the service
 * PRESERVE their stored values (updateHoliday treats undefined as "leave unchanged").
 *
 * `requireAdmin()` stays OUTSIDE the try: a caller with no admin role is not a message to paint in a
 * dialog, it is a request that must fail.
 */
export async function saveHolidayAction(
  _prev: HolidaySaveResult | null,
  formData: FormData,
): Promise<HolidaySaveResult> {
  const s = await requireAdmin();
  const id = String(formData.get('id') ?? '').trim();
  const country = String(formData.get('country') ?? 'MY');
  const holidayDate = String(formData.get('holidayDate') ?? '');
  const state = formData.has('state') ? String(formData.get('state') ?? '').trim() || null : undefined;
  const fields = {
    holidayDate,
    name: String(formData.get('name') ?? ''),
    holidayType: String(formData.get('holidayType') ?? 'public'),
    active: formData.get('active') === 'on',
    // ADR-0063: a provisional date for a not-yet-gazetted holiday (still counts as a holiday).
    tentative: formData.get('tentative') === 'on',
  };
  let rowId = id;
  try {
    if (id) {
      await updateHoliday(s, { id, ...fields, state });
    } else {
      const created = await createHoliday(s, { country, ...fields, state: state ?? null });
      rowId = created.id;
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(HOLIDAYS);
  // Editing a DATE moves the row: the master is ordered by date, so a corrected holiday can leave the page
  // it was saved from (and, with a year filter on, the view entirely). Follow it — an edit that appears to
  // delete the row is the same failure as an Add that appears to do nothing. Country is fixed on update,
  // so the country filter cannot be the one that hides an edited row.
  return { ok: true, path: await holidayFollowPath(s, formData, rowId, id ? undefined : country, holidayDate) };
}

export async function deleteHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  try {
    await deleteHoliday(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(path, e);
  }
  ok(path);
}

// ── Holiday groups (66b8f5a8 — dedicated Holiday Group tab + add/edit pages) ──
// Groups keep their state engine (states/archetype/parentGroupId — MY state auto-resolution + inheritance)
// AND gain the master fields (code/description/active) plus the reporter's tick-list (holidayIds → the
// holiday_group_holiday junction). The resolver UNIONs the ticked holidays with the automatic result.
export async function createHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await createHolidayGroup(s, {
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      active: formData.get('active') === 'on',
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
      // R18 a519a96e: optional parent group — the child inherits the parent's calendar live.
      parentGroupId: String(formData.get('parentGroupId') ?? '') || null,
      // 66b8f5a8: the ticked holidays from the master list.
      holidayIds: formData.getAll('holidayIds').map(String),
    });
  } catch (e) {
    fail(`${HOLIDAY_GROUPS}/new`, e);
  }
  ok(HOLIDAY_GROUPS);
}

export async function updateHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await updateHolidayGroup(s, {
      id,
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      active: formData.get('active') === 'on',
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
      // R18 a519a96e: the form always posts the select, so '' means "clear the parent" (service tri-state).
      parentGroupId: String(formData.get('parentGroupId') ?? '') || null,
      holidayIds: formData.getAll('holidayIds').map(String),
    });
  } catch (e) {
    fail(`${HOLIDAY_GROUPS}/${id}`, e);
  }
  ok(HOLIDAY_GROUPS);
}

export async function deleteHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteHolidayGroup(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(HOLIDAY_GROUPS, e);
  }
  ok(HOLIDAY_GROUPS);
}

// 4b0e76ae — GENERATE ENTITLEMENT. The one surviving leave-year action, re-homed onto
// /admin/leave/generate: pick a year, press Generate, and the shipped openLeaveYear grant sweep posts that
// year's entitlement for every eligible employment. The engine is untouched — what never existed was a way
// to reach it. Until this item, the ONLY caller was the Leave Year Configuration screen's Start button
// (through setLeaveYearStatusAction's draft→open transition), and deleting that screen without giving the
// sweep a new home is how a year-end silently fails to open. test/leave-generate-page.test.ts pins that
// this action has exactly ONE caller and that the caller is the Generate page.
//
// ⚠️ requireAdmin(), NOT getSession() — THIS WAS A REAL HOLE, FIXED HERE. Until 4b0e76ae this action opened
// with `const s = await getSession()`, openLeaveYear carries no admin assertion anywhere in its body, and
// leave_ledger RLS gates on can_see_employment rather than on admin. So an ordinary member who POSTed this
// server action directly would have posted accrual grants for every employment they can see. Same
// correction dcd8e32f made on the sibling delete action, for the same reason. The redirect below is a UX
// gate, not authority — the guard is.
//
// Idempotent by construction: openLeaveYear's dedupe set is built from the ledger's existing accrual rows
// at the year start, NOT from any configuration table, so pressing Generate twice never double-grants and
// clearing leave_year_config (migration 0385) cannot cause one either.
// 93249794 GREW THIS ACTION RATHER THAN MINTING A SECOND ONE, and that is a deliberate choice about the
// guard above it. `test/leave-generate-page.test.ts` asserts this action has EXACTLY ONE caller, because
// losing its last caller is a year-end failure discovered in January. A new `runLeaveGenerationAction`
// beside it would have left this one uncalled and the guard asserting a fiction — the wizard would work
// and the assertion protecting the year-open would be protecting nothing. So the wizard posts HERE, the
// unscoped post is byte-identical to the plain button it replaces (no types picked, no criteria ⇒ the
// whole-tenant sweep), and there is still exactly one route from a browser to `openLeaveYear`.
//
// The body delegates to `runLeaveGeneration` (core/leave-generation.ts), which calls the SAME
// `openLeaveYear` and then writes the processing log. It does not re-derive a single day.
export async function openLeaveYearAction(formData: FormData) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const year = Number(formData.get('year'));
  const targetMode = formData.get('targetMode') === 'individual' ? 'individual' : 'criteria';
  let res: Awaited<ReturnType<typeof runLeaveGeneration>>;
  try {
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('Invalid year');
    // r289 — THE POPULATION A PASTED EMPLOYEE ID RESOLVES AGAINST, read here rather than trusted from the
    // post: the same list step ③'s picker was filled from, so `EMP-0008` names the same person on submit
    // as it did in the live preview. Read ONLY in individual mode — the criteria path resolves nobody by
    // reference and must not pay for a list it will not look at.
    const pickPopulation = targetMode === 'individual' ? await listEmployeePickOptions(s) : [];
    res = await runLeaveGeneration(s, {
      year,
      // Empty ⇒ every type this sweep grants, exactly as the bare button did.
      leaveTypeIds: formData.getAll('leaveTypeIds').map(String).filter(Boolean),
      targetMode,
      // THE SHARED READER (core/org-criteria.ts). The hand-rolled alternative lists the field names itself,
      // so every axis added there has to be remembered in a second place — and the one that gets forgotten
      // posts fine, resolves to nothing, and narrows nobody.
      criteria:
        targetMode === 'criteria'
          ? orgCriteriaFromFields(
              (name) => formData.getAll(name).map(String),
              (name) => {
                const v = formData.get(name);
                return v == null ? null : String(v);
              },
            )
          : undefined,
      // r287 (ff1c935f) — TWO WAYS IN, ONE LIST OUT. Step ③ now offers a picker (hidden `employmentIds`
      // inputs, the MultiSelectPopover form contract) BESIDE the pasted block, which is kept: it is how a
      // bulk run is set up today. `mergeEmploymentSelection` is the SAME function the screen's live
      // preview calls on the SAME two fields, so the population confirmed on screen cannot differ from
      // the one this run grants to. Do not inline either half.
      //
      // r289 — …and over the SAME POPULATION the screen resolved against, which is what makes a pasted
      // Employee ID mean one person rather than two different things on the two sides of the submit. An
      // unresolved token is NOT dropped: it goes on to `resolveOrgCriteriaTargets` exactly as typed, so a
      // typo covers nobody instead of quietly making a twelve-person run into a ten-person one.
      employmentIds:
        targetMode === 'individual'
          ? mergeEmploymentSelection(
              formData.getAll('employmentIds').map(String),
              String(formData.get('employmentIdsRaw') ?? ''),
              pickPopulation,
            )
          : undefined,
    });
  } catch (e) {
    fail(GENERATE, e);
  }
  // Localised HERE before the redirect (the dcd8e32f convention): ToastFromQuery renders the raw string, so
  // an i18n key in the URL would surface to HR verbatim.
  //
  // r301 (e5018593) — ONE message for both halves of the run, composed from the result by one pure function
  // (lib/leave-generation-message.ts). A failed earned accrual rides `?error=` beside it: the entitlement is
  // committed and the toast says so, and the error says the earned part did not run and where to run it.
  const message = leaveGenerationMessages((key, values) => t(key as never, values as never), res);
  okToast(GENERATE, message.toast, message.error);
}

export async function assignRoleAction(formData: FormData) {
  const s = await getSession();
  try {
    await assignRole(s, {
      appUserId: String(formData.get('appUserId')),
      role: String(formData.get('role')) as
        | 'employee'
        | 'manager'
        | 'hr_admin'
        | 'super_admin'
        | 'payroll_partner'
        | 'performance_comp_partner',
      companyId: (formData.get('companyId') as string) || undefined,
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

export async function revokeRoleAction(formData: FormData) {
  const s = await getSession();
  try {
    await revokeRole(s, { roleAssignmentId: String(formData.get('roleAssignmentId')) });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

// ADR-0072 — invitation-only account creation. Invite by email + role (+ optional company scope);
// revoke a still-pending invitation. Group-admin gated in the service; RLS is the backstop.
export async function inviteUserAction(formData: FormData) {
  const s = await getSession();
  try {
    // personId is REQUIRED (0279). It was previously dropped here even though app_invitation.personId
    // exists and inviteUser accepts it, which is how nameless, unattached logins got created. ADR-0072
    // is invitation-only with no self sign-up, so the invitee always already has a person row.
    const personId = String(formData.get('personId') ?? '').trim();
    if (!personId) throw new Error('Select the employee this invitation is for.');
    await inviteUser(s, {
      email: String(formData.get('email') ?? '').trim(),
      role: String(formData.get('role') ?? 'employee'),
      companyId: (formData.get('companyId') as string) || null,
      personId,
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

/** Archive (switch off) or restore a login — group-admin only, guarded in the service, RLS backstop. */
export async function archiveUserAction(formData: FormData) {
  const s = await getSession();
  try {
    await setAppUserArchived(s, {
      appUserId: String(formData.get('appUserId')),
      archived: archived(formData),
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

/**
 * ADR-0082 §2.8 — give or take away one person's access to the assistant.
 *
 * A per-user grant ON TOP of the billable module, and both gates fail closed. It lives on the Users
 * screen rather than getting one of its own because "who may use this" is the same question that screen
 * already answers for roles — and a second screen for one toggle is a menu row nobody would find.
 */
export async function setAssistantGrantAction(formData: FormData) {
  const s = await getSession();
  const appUserId = String(formData.get('appUserId'));
  try {
    if (String(formData.get('granted')) === 'true') await grantAssistant(s, { appUserId });
    else await revokeAssistant(s, { appUserId });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

export async function revokeInvitationAction(formData: FormData) {
  const s = await getSession();
  try {
    await revokeInvitation(s, { invitationId: String(formData.get('invitationId')) });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

// ── Edit + state-aware remove actions (department actions are above) ──
const archived = (fd: FormData) => fd.get('archived') === 'true';

export async function updatePositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await updatePosition(s, { id: String(fd.get('id')), title: String(fd.get('title') ?? '').trim(), jobFamily: (fd.get('jobFamily') as string) || undefined });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archivePositionAction(fd: FormData) {
  const s = await getSession();
  try { await archivePosition(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function deletePositionAction(fd: FormData) {
  const s = await getSession();
  try { await deletePosition(s, { id: String(fd.get('id')) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function updateCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await updateCostCenter(s, { id: String(fd.get('id')), code: String(fd.get('code') ?? '').trim(), name: String(fd.get('name') ?? '').trim() });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archiveCostCenterAction(fd: FormData) {
  const s = await getSession();
  try { await archiveCostCenter(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function deleteCostCenterAction(fd: FormData) {
  const s = await getSession();
  try { await deleteCostCenter(s, { id: String(fd.get('id')) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function createBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try {
    await createBusinessUnit(s, {
      companyId: String(fd.get('companyId')),
      code: String(fd.get('code') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
    });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function updateBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  // 6fadb036: headEmploymentId tri-state (absent ⇒ untouched; empty ⇒ clear).
  const headRaw = fd.get('headEmploymentId');
  try {
    await updateBusinessUnit(s, {
      id: String(fd.get('id')),
      code: String(fd.get('code') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
      headEmploymentId: headRaw === null ? undefined : String(headRaw).trim() || null,
    });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archiveBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try { await archiveBusinessUnit(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

/**
 * 65b22c00 — see applyDefaultCycleSection.
 *
 * Enhance Company General Tab (bc5d4891): read each field, trim, and treat empty as an explicit clear
 * (empty string -> the service normalizes to null). Website format is validated in the service.
 */
async function applyCompanyDetailsSection(s: Session, fd: FormData): Promise<void> {
  const str = (k: string) => String(fd.get(k) ?? '').trim();
  await updateCompany(s, {
      id: String(fd.get('id')),
      legalName: String(fd.get('legalName') ?? '').trim(),
      registrationNo: (fd.get('registrationNo') as string) || undefined,
      country: (fd.get('country') as string) || undefined,
      currency: (fd.get('currency') as string) || undefined,
      // Company Information
      companyLabel: str('companyLabel'),
      industry: str('industry'),
      website: str('website'),
      businessType: str('businessType'),
      // Contact Information
      addressLine1: str('addressLine1'),
      addressLine2: str('addressLine2'),
      addressLine3: str('addressLine3'),
      city: str('city'),
      state: str('state'),
      addressCountry: str('addressCountry'),
      postcode: str('postcode'),
      phone: str('phone'),
      fax: str('fax'),
  });
}

/**
 * 65b22c00 — ONE "Save Changes" for Organization → a company → General.
 *
 * WHAT IT IS NOT. It is not a blanket write. Each of the three cards reaches a DIFFERENT service with a
 * different payload, so this unpacks each card's OWN FormData — the same fields, the same hidden inputs,
 * the same absences — and hands it to that card's own `apply*Section` helper, the very same one the
 * per-card action calls, in the DECLARED order. Nothing here writes a table.
 *
 * ONLY DIRTY SECTIONS ARE WRITTEN. The client names them in `sections`; a card the administrator did not
 * touch is not in the list, its service is never called, and no event is appended for it.
 *
 * A SECTION NAME THIS TAB DOES NOT OWN IS REFUSED OUTRIGHT, before anything is written. That is the
 * bucket (b) fence expressed on the server: `COMPANY_GENERAL_TAB_SECTION_ORDER` is the whole vocabulary,
 * so a crafted payload naming `delete` or `bank` cannot reach a writer through this door.
 *
 * IT RETURNS RATHER THAN REDIRECTS, unlike every per-card action on this screen. A redirect cannot say
 * WHICH write failed, and the classification requires a per-section failure rather than one
 * all-or-nothing error. It is also what makes "stay on the screen" free for these three: there is no
 * redirect to stay on the right side of — `revalidatePath` plus the client's own `router.refresh()` is
 * the whole of it.
 */
export async function saveCompanyGeneralTabAction(formData: FormData): Promise<TabSaveResult> {
  const s = await getSession();
  const companyId = String(formData.get('companyId'));
  const requested = String(formData.get(SECTIONS_FIELD) ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  const order: readonly string[] = COMPANY_GENERAL_TAB_SECTION_ORDER;
  const unknown = requested.filter((x) => !order.includes(x));
  if (unknown.length > 0) {
    return { ok: false, saved: [], failedSection: unknown[0], error: `Unknown section: ${unknown[0]}` };
  }

  const writers: Record<string, (s: Session, fd: FormData) => Promise<void>> = {
    company: applyCompanyDetailsSection,
    cycle: applyDefaultCycleSection,
    parent: applyParentSection,
  };

  const saved: string[] = [];
  for (const section of order) {
    if (!requested.includes(section)) continue;
    const write = writers[section];
    // Unreachable while the map covers the order list (pinned by test/organization-general-tab-save.test.ts);
    // refusing rather than skipping means a section that lost its writer can never report itself saved.
    if (!write) {
      return { ok: false, saved, failedSection: section, error: `No writer for section: ${section}` };
    }
    try {
      await write(s, companySectionFormData(formData, section, companyId));
      saved.push(section);
    } catch (e) {
      if (saved.length > 0) revalidateCompany(companyId);
      return { ok: false, saved, failedSection: section, error: (e as Error).message };
    }
  }

  revalidateCompany(companyId);
  return { ok: true, saved };
}

/** The list carries the company's name and archived badge, so both paths are invalidated (okCompany). */
function revalidateCompany(companyId: string): void {
  revalidatePath(ORGANIZATION);
  if (companyId) revalidatePath(`${ORGANIZATION}/${companyId}`);
}

/**
 * Rebuild one card's own FormData out of the consolidated payload.
 *
 * THE COMPANY IS FORCED FROM THE ONE TRUSTED TOP-LEVEL VALUE, never taken from a section's own hidden
 * copy: three hidden copies of the same id are three chances for a crafted payload to point one write at
 * another company. Both spellings are dropped and re-set, because this screen calls it `id` on the
 * details card and `companyId` on the other two, and all three sections mean the same company.
 *
 * Everything else is taken verbatim, INCLUDING absences — an unpacked section must be indistinguishable
 * from what that card would have posted alone, or the "absent means leave as-is" contract breaks.
 */
function companySectionFormData(formData: FormData, section: string, companyId: string): FormData {
  const prefix = `${SECTION_FIELD_PREFIX}.${section}.`;
  const out = new FormData();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(prefix)) continue;
    const field = key.slice(prefix.length);
    if (field === 'companyId' || field === 'id') continue;
    out.append(field, value);
  }
  out.set('companyId', companyId);
  out.set('id', companyId);
  return out;
}

export async function updateCompanyAction(fd: FormData) {
  const s = await getSession();
  // 65b22c00 — this form posts the company as `id`, not `companyId`; the destination reads the same one
  // the write does, so a save and its confirmation can never name different companies.
  const id = String(fd.get('id'));
  try {
    await applyCompanyDetailsSection(s, fd);
  } catch (e) {
    failCompany(e, id, companyTab(fd));
  }
  const t = await getTranslations('admin.organization');
  okCompany(id, t('savedToast'), companyTab(fd));
}

/**
 * 65b22c00 — THE ONE COMPANY ACTION WITH TWO HOMES, so the destination comes from the form.
 *
 * This is bound on the company's own screen AND on every row of the company list
 * (components/company-rows.tsx). Pressed on the list it must leave the reader on the list — opening a
 * company because they archived its row would be a regression on a screen this item does not touch.
 * `fromCompanyScreen` reads the closed-list marker the panel's two archive forms carry explicitly.
 *
 * Both destinations revalidate the list, so the row's Active/Archived badge is right either way.
 */
export async function archiveCompanyAction(fd: FormData) {
  const s = await getSession();
  const id = String(fd.get('id'));
  const toArchive = archived(fd);
  const stay = fromCompanyScreen(fd);
  try {
    await archiveCompany(s, { id, archived: toArchive });
  } catch (e) {
    if (stay) failCompany(e, id, companyTab(fd));
    fail(ORG, e);
  }
  if (!stay) ok(ORG);
  const t = await getTranslations('admin.organization');
  okCompany(id, t(toArchive ? 'archivedToast' : 'unarchivedToast'), companyTab(fd));
}

/**
 * 65b22c00 — THE ONE SAVE ON THIS SCREEN THAT MUST NOT STAY, and finding 2 of
 * docs/audits/65b22c00-organization-save-classification.md is why: after a successful delete the row the
 * detail page reads is gone, `listCompanies` no longer contains it, and that page's own scope guard
 * answers a missing id with notFound(). "Staying" would hand the reader a 404 for the company they just
 * deleted. So success returns to the LIST, with the confirmation there.
 *
 * A REFUSAL is the opposite case and returns to the company: `deleteCompany` throws InUseError when a
 * department, employment or subsidiary still points at it, and that message belongs on the screen that
 * holds the button — where Archive is the next thing to press.
 */
export async function deleteCompanyAction(fd: FormData) {
  const s = await getSession();
  const id = String(fd.get('id'));
  try {
    await deleteCompany(s, { id });
  } catch (e) {
    failCompany(e, id, companyTab(fd));
  }
  const t = await getTranslations('admin.organization');
  okToast(ORG, t('deletedToast'));
}

export async function updateLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  // Leave Type master page (feedback 097de541): the identity sub-form posts `identity=1` (marker) and edits
  // the free-text description alongside the name. OWN tri-state (mirrors backdating): only when the marker is
  // present do we forward `description`, so any other sub-form save leaves the description column untouched.
  // Empty string ⇒ null (service trims + treats blank as cleared).
  const touchIdentity = fd.get('identity') === '1';
  // Edit Paid/Unpaid on rename (feedback 75953777): the identity/rename sub-form now also carries the
  // Paid/Unpaid checkbox. The `identity=1` marker guarantees the form was submitted, so an unchecked box is a
  // genuine "unpaid" choice (checkbox absent ⇒ 'on' missing ⇒ false), not "untouched". Any OTHER sub-form
  // omits the marker and thus leaves `paid` undefined ⇒ the column stays untouched (tri-state). No new marker.
  // Edit Leave Type Code (feedback a7194511): the identity/rename form now also carries the Code input — but
  // ONLY for NON-statutory types. Statutory (and EMERGENCY) codes keep the field readOnly with NO `name` attr,
  // so `fd.get('code')` is null for them ⇒ newCode stays undefined ⇒ the code column is untouched (tri-state).
  // A non-statutory type always posts its code (even unchanged); the service no-ops when it equals the current
  // code and otherwise normalizes / shape-validates / uniqueness-checks / statutory-guards before persisting.
  const rawCode = fd.get('code');
  const identityFields = touchIdentity
    ? {
        description: String(fd.get('description') ?? '').trim() === '' ? null : String(fd.get('description')).trim(),
        paid: fd.get('paid') === 'on',
        ...(rawCode !== null ? { newCode: String(rawCode) } : {}),
      }
    : {};
  // #25 visibility: the eligibility form posts `eligibility=1` (a marker hidden input) so a name-only
  // rename — which doesn't carry that marker — leaves the rule untouched (tri-state in updateLeaveType).
  const touchEligibility = fd.get('eligibility') === '1';
  const minRaw = String(fd.get('minServiceMonths') ?? '').trim();
  // Min-service unit (#f88f0a63): the eligibility form posts minServiceUnit ('months' | 'days') beside the
  // duration. Absent/blank ⇒ undefined so cleanEligibility defaults it to 'months' (legacy compat). The unit
  // is only persisted alongside a surviving positive minServiceMonths.
  const unitRaw = String(fd.get('minServiceUnit') ?? '').trim();
  // Multi-select (#badc5966): the gender / marital checkbox groups post repeated inputs → getAll yields the
  // selected values as arrays. cleanEligibility de-dupes, validates, and collapses an empty array to "no
  // restriction".
  let eligibility: LeaveEligibility | undefined;
  if (touchEligibility) {
    eligibility = {
      gender: fd.getAll('gender').map(String),
      maritalStatus: fd.getAll('maritalStatus').map(String),
      minServiceMonths: minRaw === '' ? undefined : Number(minRaw),
      minServiceUnit: unitRaw === '' ? undefined : (unitRaw as 'months' | 'days'),
    };
    // Organisation Assignment criteria (Enhance Leave Criteria Configuration): each org field's ChipMultiSelect
    // posts one repeated input per selected value → getAll yields the list. cleanEligibility de-dupes, drops
    // blanks and collapses an empty array to "no restriction" (no catalogue hard-validation, so a value later
    // deactivated still re-saves cleanly). Iterating the single descriptor keeps the action in lock-step.
    for (const c of ORG_ASSIGNMENT_CRITERIA) {
      eligibility[c.key] = fd.getAll(c.key).map(String);
    }
  }
  // Probation eligibility (d6bdbd55): the eligibility sub-form also posts a `probation` select ('' | confirmed_only
  // | probation_only). It rides the SAME `eligibility=1` marker, so an unrelated save leaves the column untouched
  // (undefined). Blank ⇒ null (clears the restriction); a concrete value sets it. The service re-validates against
  // the closed set. Stored in leave_type.probation_eligibility (its own column), not the eligibility jsonb.
  const probationRaw = String(fd.get('probation') ?? '').trim();
  const probationEligibility = touchEligibility
    ? probationRaw === ''
      ? null
      : (probationRaw as 'confirmed_only' | 'probation_only')
    : undefined;
  // ADR-0048: the durations form posts `durations=1` (marker) plus a `duration` checkbox per allowed slot,
  // so a name/eligibility edit that doesn't carry that marker leaves the allow-list untouched (same tri-state).
  const touchDurations = fd.get('durations') === '1';
  const durations = touchDurations
    ? (fd.getAll('duration').map(String) as LeaveDurationType[])
    : undefined;
  // Supporting-document config: the document sub-form posts `document=1` (marker) so a rename / eligibility
  // / durations edit that omits it leaves the doc columns untouched (same tri-state guard).
  const touchDocument = fd.get('document') === '1';
  let docFields: {
    requiresDocument?: boolean;
    mandatoryAfterDays?: number | null;
    allowedMimeTypes?: string[];
    maxDocBytes?: number;
    employeeRemarkRequired?: boolean;
    hrRemarkRequired?: boolean;
  } = {};
  if (touchDocument) {
    const afterRaw = String(fd.get('mandatoryAfterDays') ?? '').trim();
    const mbRaw = String(fd.get('maxFileSizeMb') ?? '').trim();
    docFields = {
      requiresDocument: fd.get('requiresDocument') === 'on',
      mandatoryAfterDays: afterRaw === '' ? null : Number(afterRaw),
      allowedMimeTypes: fd.getAll('allowedMimeType').map(String),
      maxDocBytes: mbRaw === '' ? 10 * 1024 * 1024 : Math.round(Number(mbRaw) * 1024 * 1024),
      employeeRemarkRequired: fd.get('employeeRemarkRequired') === 'on',
      hrRemarkRequired: fd.get('hrRemarkRequired') === 'on',
    };
  }
  // Unpaid payroll-impact: the sub-form posts `payrollImpact=1` (marker) so a rename / eligibility / durations
  // / document edit that omits it leaves send_to_payroll untouched (same tri-state guard). "Affects payroll
  // deduction" is display-only (derived from !paid) and is NOT read/forwarded here.
  const touchPayroll = fd.get('payrollImpact') === '1';
  const payrollFields = touchPayroll ? { sendToPayroll: fd.get('sendToPayroll') === 'on' } : {};
  // Configurable backdated-leave restriction (0133): its own sub-form posts `backdating=1` (marker) so a
  // rename / eligibility / durations / document / payroll edit that omits it leaves backdating_limit_days
  // untouched (same tri-state guard). Empty input ⇒ null (clears the limit ⇒ unrestricted); a number sets it.
  const touchBackdating = fd.get('backdating') === '1';
  const backdatingRaw = String(fd.get('backdatingLimitDays') ?? '').trim();
  const backdatingFields = touchBackdating
    ? { backdatingLimitDays: backdatingRaw === '' ? null : Number(backdatingRaw) }
    : {};
  // Application Limits (feedback c6ffa725): its own sub-form posts `applicationLimits=1` (marker),
  // mirroring the backdating tri-state guard above. Empty input ⇒ null (Unlimited, which is what every
  // existing leave type means and how it behaves today); a number sets the annual application ceiling.
  // ad9cb5c5 adds the PERIOD to the same sub-form and the same marker: the ceiling and the window it is
  // counted over are one decision, and a period posted without a ceiling is refused by the database.
  const touchApplicationLimits = fd.get('applicationLimits') === '1';
  const maxDaysPerLeaveYearRaw = String(fd.get('maxDaysPerLeaveYear') ?? '').trim();
  const maxDaysPeriodRaw = String(fd.get('maxDaysPeriod') ?? '').trim();
  const applicationLimitFields = touchApplicationLimits
    ? {
        maxDaysPerLeaveYear: maxDaysPerLeaveYearRaw === '' ? null : Number(maxDaysPerLeaveYearRaw),
        // Clearing the ceiling clears the period with it — "Unlimited, per calendar year" is not a state.
        maxDaysPeriod: maxDaysPerLeaveYearRaw === '' || maxDaysPeriodRaw === '' ? null : maxDaysPeriodRaw,
      }
    : {};
  // Maximum Consecutive Leave (c6ffa725 rev 2): its own sub-form posts `maxConsecutive=1` (marker), separate
  // from `applicationLimits` above — the two rules answer different questions ("in a year" vs "in one go")
  // and a shared marker would let a save of one silently clear the other. Blank maximum ⇒ Unlimited, and the
  // UNIT IS ONLY FORWARDED WHEN A MAXIMUM IS PRESENT, so a blank save reliably clears BOTH columns as the
  // all-or-nothing pair the DB CHECK requires (leave_type_max_consecutive_pair_ck).
  const touchMaxConsecutive = fd.get('maxConsecutive') === '1';
  const maxConsecutiveRaw = String(fd.get('maxConsecutiveDays') ?? '').trim();
  const maxConsecutiveUnitRaw = String(fd.get('maxConsecutiveUnit') ?? '').trim();
  const maxConsecutiveFields = touchMaxConsecutive
    ? maxConsecutiveRaw === ''
      ? { maxConsecutiveDays: null, maxConsecutiveUnit: null }
      : {
          maxConsecutiveDays: Number(maxConsecutiveRaw),
          maxConsecutiveUnit: (maxConsecutiveUnitRaw === 'working_days' ? 'working_days' : 'calendar_days') as
            | 'calendar_days'
            | 'working_days',
        }
    : {};
  // Minimum advance-notice rule (0159): its own sub-form posts `minAdvance=1` (marker), mirroring the
  // backdating tri-state guard above. Empty input ⇒ null (clears the requirement); a number sets it.
  //
  // Advance Notice — calendar days or working days (7daac043): the Day Type select lives in the SAME
  // sub-form and rides the SAME marker, so the requirement and the unit it is read in save together and a
  // save of any OTHER card can never reset either. THE UNIT IS ONLY FORWARDED WITH A REQUIREMENT: a blank
  // number clears both, because a unit with no figure is inert configuration that looks set. An
  // unrecognised value falls back to 'calendar_days' — today's reading — and the service re-validates it
  // against the closed set behind the DB CHECK.
  const touchMinAdvance = fd.get('minAdvance') === '1';
  const minAdvanceRaw = String(fd.get('minAdvanceDays') ?? '').trim();
  const minAdvanceDayTypeRaw = String(fd.get('minAdvanceDayType') ?? '').trim();
  const minAdvanceFields = touchMinAdvance
    ? minAdvanceRaw === ''
      ? { minAdvanceDays: null, minAdvanceDayType: null }
      : {
          minAdvanceDays: Number(minAdvanceRaw),
          minAdvanceDayType: (minAdvanceDayTypeRaw === 'working_days' ? 'working_days' : 'calendar_days') as
            | 'calendar_days'
            | 'working_days',
        }
    : {};
  // The three REQUEST-VALIDATION rules, pre-merged into one fragment. They stay three independent
  // tri-states; only the assembly is flattened, because the updateLeaveType call below is already at
  // TypeScript's union-complexity ceiling (TS2590) and one more conditional spread tips it over.
  // The ANNOTATION is load-bearing: each `touchX ? {…} : {}` fragment is a two-member union, and spreading
  // enough of them into one literal multiplies out until TypeScript refuses with TS2590. Declaring the
  // merged shape collapses these three to one member.
  const requestRuleFields: {
    backdatingLimitDays?: number | null;
    maxDaysPerLeaveYear?: number | null;
    maxDaysPeriod?: string | null;
    maxConsecutiveDays?: number | null;
    maxConsecutiveUnit?: 'calendar_days' | 'working_days' | null;
    minAdvanceDays?: number | null;
    minAdvanceDayType?: 'calendar_days' | 'working_days' | null;
  } = { ...backdatingFields, ...applicationLimitFields, ...maxConsecutiveFields, ...minAdvanceFields };
  // Partial Leave Approval (ADR-0068): its own sub-form posts `partialApproval=1` (marker) so a rename /
  // eligibility / durations / document / payroll / backdating edit that omits it leaves per_date_approval
  // untouched (same tri-state guard). Unchecked-when-rendered ⇒ false; the marker distinguishes that from
  // "block not shown at all" ⇒ leave column.
  const touchPartial = fd.get('partialApproval') === '1';
  const partialFields = touchPartial ? { perDateApproval: fd.get('perDateApproval') === 'on' } : {};
  // Duplicate Leave Application Restriction (d5e51c34): its own sub-form posts `duplicatePolicy=1` (marker)
  // plus a `duplicatePolicyValue` radio (allow | restrict_same | restrict_any). Any other sub-form save omits
  // the marker ⇒ duplicate_application_policy stays untouched (same tri-state guard as partialApproval). An
  // unrecognised value falls back to 'allow' (the safe, behaviour-preserving default); the service re-validates.
  const touchDuplicatePolicy = fd.get('duplicatePolicy') === '1';
  const duplicatePolicyRaw = String(fd.get('duplicatePolicyValue') || '');
  const duplicatePolicyFields = touchDuplicatePolicy
    ? {
        duplicateApplicationPolicy: (['allow', 'restrict_same', 'restrict_any'].includes(duplicatePolicyRaw)
          ? duplicatePolicyRaw
          : 'allow') as 'allow' | 'restrict_same' | 'restrict_any',
      }
    : {};
  // Configurable Negative Leave Balance Validation (0ef0defd): its own sub-form posts `negativeBalance=1`
  // (marker) plus a Yes/No radio `allowNegativeBalanceValue` (yes ⇒ permit going negative; no ⇒ block over-
  // application). Any other sub-form save omits the marker ⇒ allow_negative_balance stays untouched (same
  // tri-state guard as duplicatePolicy). Forwarded as a concrete boolean; the service persists it.
  // bc512dc3 adds the FLOOR to the same sub-form and the same marker: one switch, one floor, one decision.
  // A blank figure means unbounded (today's behaviour), and turning the switch to No clears any floor —
  // the database refuses a floor with no permission to go negative, so this cannot post that pair.
  const touchNegativeBalance = fd.get('negativeBalance') === '1';
  const allowNegativeBalanceValue = fd.get('allowNegativeBalanceValue') === 'yes';
  const maxNegativeBalanceRaw = String(fd.get('maxNegativeBalance') ?? '').trim();
  const negativeBalanceFields: { allowNegativeBalance?: boolean; maxNegativeBalance?: number | null } =
    touchNegativeBalance
      ? {
          allowNegativeBalance: allowNegativeBalanceValue,
          maxNegativeBalance:
            allowNegativeBalanceValue && maxNegativeBalanceRaw !== '' ? Number(maxNegativeBalanceRaw) : null,
        }
      : {};
  // Balance Deduction Source (cdf9ca48): its own sub-form posts `balanceSource=1` (marker) plus a mode radio
  // (`balanceSourceMode` = own | other) and, for 'other', the chosen `balanceSourceTypeId`. Mode 'own' — and
  // 'other' with nothing picked — both clear the column, so the dropdown can never leave a half-configured
  // "deduct from another type, but which one?" state. Any other sub-form save omits the marker ⇒ the column
  // stays untouched (same tri-state guard as negativeBalance). The service validates self-reference + chains.
  // Both are annotated with an OPTIONAL-property type rather than left to inference: an un-annotated
  // `cond ? {k: v} : {}` is a two-member union, and this call site already spreads ~18 of them — two more
  // doubled the union twice over and tipped tsc into TS2590 ("union type too complex"). One declared type
  // per field object keeps the spread a single shape.
  const touchBalanceSource = fd.get('balanceSource') === '1';
  const balanceSourceModeRaw = String(fd.get('balanceSourceMode') ?? '');
  const balanceSourceIdRaw = String(fd.get('balanceSourceTypeId') ?? '').trim();
  const balanceSourceFields: { balanceSourceTypeId?: string | null } = touchBalanceSource
    ? {
        balanceSourceTypeId:
          balanceSourceModeRaw === 'other' && balanceSourceIdRaw !== '' ? balanceSourceIdRaw : null,
      }
    : {};
  // Allow Unpaid Leave (a7fab30b): its own sub-form posts `allowUpl=1` (marker) plus a Yes/No radio
  // (`allowUnpaidLeaveValue`). Forwarded as a concrete boolean; mirrors negativeBalance exactly.
  const touchAllowUpl = fd.get('allowUpl') === '1';
  const allowUplFields: { allowUnpaidLeave?: boolean } = touchAllowUpl
    ? { allowUnpaidLeave: fd.get('allowUnpaidLeaveValue') === 'yes' }
    : {};
  // Employee Leave View Configuration (65dec703 / dup 1fedb473): the ESS-view checklist posts `essView=1`
  // (marker) plus one checkbox per component (`essView_<key>`). An unchecked box does not post, so we build
  // the COMPLETE map from the closed key list (checked ⇒ true/visible, absent ⇒ false/hidden) and replace
  // the column wholesale. Any other sub-form save omits the marker ⇒ ess_view_config stays untouched.
  // Consolidation (2bc2f2a3): the merged view-configuration sub-form posts BOTH markers (`essView=1` and
  // `formula=1`) in ONE submit — selections land on ess_view_config, explanations on formula_explanations.
  // The two tri-states stay independent so either marker alone still works.
  const touchEssView = fd.get('essView') === '1';
  const essViewFields = touchEssView
    ? {
        essViewConfig: Object.fromEntries(
          ESS_VIEW_COMPONENT_KEYS.map((key) => [key, fd.get(`essView_${key}`) === 'on']),
        ) as EssViewConfig,
      }
    : {};
  // Leave Entitlement Formula Management (79011509, consolidated by 2bc2f2a3, narrowed by ed17a4f9): the
  // view-configuration sub-form posts `formula=1` (marker) plus, per Leave Summary item, two free-text fields
  // (`formula_<key>_description`, `formula_<key>_formula`). We build the COMPLETE { key: entry } map from
  // LEAVE_EXPLANATION_KEYS, which ed17a4f9 reduced to exactly the ess-view key set (the summary's own items);
  // a key the form never rendered posts nothing ⇒ '' ⇒ dropped by the service, which trims + drops blanks +
  // normalises an all-blank map to null (clear). The third "Result / Date (optional)" field is gone at the
  // reporter's request and is no longer read. Any other sub-form save omits the marker ⇒
  // formula_explanations stays untouched (same tri-state guard as essView).
  //
  // Smart content reuse (ed17a4f9 §4) needs NOTHING here, and that is the design: the template only pre-fills
  // the textareas, so what arrives in this FormData is whatever HR reviewed and left in the boxes. There is
  // no separate "apply template" write path that could overwrite wording behind their back.
  const touchFormula = fd.get('formula') === '1';
  const formulaFields = touchFormula
    ? {
        formulaExplanations: Object.fromEntries(
          LEAVE_EXPLANATION_KEYS.map((key) => [
            key,
            {
              description: String(fd.get(`formula_${key}_description`) ?? ''),
              formula: String(fd.get(`formula_${key}_formula`) ?? ''),
            },
          ]),
        ) as LeaveFormulaConfig,
      }
    : {};
  // Day Type Inclusion (feedback ef6d7146): the "Day Type Inclusion" sub-form posts `dayTypeInclusion=1`
  // (marker) plus one checkbox per day type (`dayType_<key>`). An unchecked box does not post, so we build the
  // COMPLETE five-key vector (checked ⇒ true/counted, absent ⇒ false/skipped) and hand it to the service,
  // which normalises an all-false vector to null (inert). Any other sub-form save omits the marker ⇒
  // day_type_inclusion stays untouched (same tri-state guard as essView).
  const touchDayTypeInclusion = fd.get('dayTypeInclusion') === '1';
  const dayTypeInclusionFields = touchDayTypeInclusion
    ? {
        dayTypeInclusion: Object.fromEntries(
          DAY_TYPE_INCLUSION_KEYS.map((key) => [key, fd.get(`dayType_${key}`) === 'on']),
        ) as unknown as DayTypeInclusion,
      }
    : {};
  // Override Leave Application (feedback 56910869): the "Override Leave Application" sub-form posts
  // `overrideRules=1` (marker) plus one row per (trigger, action) pair the card offers — an `override_<t>`
  // select naming the chosen action and an `overrideOn_<t>` checkbox. Any other sub-form save omits the
  // marker ⇒ override_rules stays untouched (same tri-state guard as dayTypeInclusion).
  //
  // ONE ROW PER TRIGGER is what the form collects, which is why the whole set is rebuilt and REPLACED on
  // every save rather than merged: a partial write is how a rule HR believes they turned off stays on. An
  // unticked box does not post, so absent ⇒ enabled:false — the DEFAULT-OFF reading, and the only reading
  // that cannot turn a rule nobody enabled into behaviour. The service validates the vocabulary.
  const touchOverrideRules = fd.get('overrideRules') === '1';
  const overrideRulesFields = touchOverrideRules
    ? {
        overrideRules: LEAVE_OVERRIDE_TRIGGERS.flatMap((trigger) => {
          const action = String(fd.get(`override_${trigger}`) ?? '').trim();
          if (action === '') return [];
          return [
            {
              trigger,
              action: action as LeaveOverrideAction,
              enabled: fd.get(`overrideOn_${trigger}`) === 'on',
            },
          ];
        }),
      }
    : {};
  // Leave Type Visual Configuration Enhancement (639fdf77): the visual sub-form posts `visual=1` (marker) plus
  // `color` (one of the 7 palette tokens, or '' to clear) + `icon` (an icon-registry key, or '' to clear).
  // OWN tri-state (mirrors essView) — any other sub-form save omits the marker ⇒ color/icon stay untouched.
  // Empty string ⇒ null (the service trims + treats blank as cleared). The service rejects out-of-allow-list
  // values. Display-only; never read for entitlement / eligibility / workflow / calculation.
  const touchVisual = fd.get('visual') === '1';
  const visualFields = touchVisual
    ? {
        color: String(fd.get('color') ?? '').trim() === '' ? null : String(fd.get('color')).trim(),
        icon: String(fd.get('icon') ?? '').trim() === '' ? null : String(fd.get('icon')).trim(),
      }
    : {};
  // Leave Unit Configuration (e4980382): its own sub-form posts `leaveUnit=1` (marker) plus a Day/Hour select,
  // so any other sub-form save that omits the marker leaves leave_unit untouched (same tri-state guard). The
  // value is constrained to 'hour' else 'day' (default) — the service also validates against the closed set.
  const touchLeaveUnit = fd.get('leaveUnit') === '1';
  const leaveUnitFields = touchLeaveUnit
    ? { leaveUnit: (fd.get('leaveUnitValue') === 'hour' ? 'hour' : 'day') as 'day' | 'hour' }
    : {};
  // Leave Year Type override (e1a51aea): the General step's "Leave Year Type" sub-step posts `yearCycle=1`
  // (marker) plus a `yearCycleValue` select ('' = company default ⇒ null | a2a | c2c | a2c — all three
  // values are LIVE since 18e15fc1). The raw value is forwarded UNSANITISED so the service rejects any
  // unknown value loudly against its closed set — silently coercing here would store nothing and hide the
  // error. Any other sub-form save omits the marker ⇒ tri-state untouched.
  const touchYearCycle = fd.get('yearCycle') === '1';
  const yearCycleRaw = String(fd.get('yearCycleValue') ?? '').trim();
  const yearCycleFields = touchYearCycle
    ? { yearCycleOverride: yearCycleRaw === '' ? null : yearCycleRaw }
    : {};
  // Leave Type Employee Visibility (7b11f1c1, simplified by 464b58e6): its own sub-form posts `visibility=1`
  // (marker) plus ONE checkbox — `employeeCanApply`, whether employees may apply for this type. A checked box
  // posts 'on', an unchecked box does not post, so with the marker present we forward a concrete boolean:
  // checked ⇒ true, absent ⇒ false. Any other sub-form save omits the marker ⇒ the column stays untouched
  // (same tri-state guard as essView/leaveUnit). The service rejects employeeCanApply=false on a
  // statutory-entitlement type, and the form now shows that switch locked rather than refusing after Save.
  //
  // `visibleToEmployee` IS DELIBERATELY NOT FORWARDED HERE, and re-adding it would be a silent data change,
  // not a tidy-up. Its checkbox is gone from that sub-form, so `fd.get('visibleToEmployee')` is absent on
  // every visibility save — reading it would evaluate to FALSE and HIDE every leave type HR touched from the
  // employee's Leave tab. The column keeps its single writer: the placement sub-form (`placement=1`), whose
  // Hidden option maps onto it in core/admin.ts. core/admin.ts still accepts p.visibleToEmployee — the
  // placement mapping and the service tests use it — only this form stops posting it.
  const touchVisibility = fd.get('visibility') === '1';
  const visibilityFields = touchVisibility ? { employeeCanApply: fd.get('employeeCanApply') === 'on' } : {};
  // Leave grouping visibility (b653ac1b): its own sub-form posts `placement=1` (marker) plus a
  // `placementValue` of primary | secondary | hidden. With the marker present we forward the chosen value so
  // the service maps it onto ess_placement + the shared visible_to_employee switch (hidden ⇒ flag false). Any
  // other sub-form save omits the marker ⇒ ess_placement + the flag stay untouched (same tri-state guard).
  const touchPlacement = fd.get('placement') === '1';
  const placementRaw = String(fd.get('placementValue') || '');
  const placementFields = touchPlacement
    ? {
        essPlacement: (['primary', 'secondary', 'hidden'].includes(placementRaw) ? placementRaw : 'secondary') as
          | 'primary'
          | 'secondary'
          | 'hidden',
      }
    : {};
  // Custom validation messages (custom-messages migration): each rule's "Custom system message" textarea
  // lives in the SAME sub-form as its rule config (backdating ⇒ `backdating=1`; min-advance ⇒ `minAdvance=1`),
  // so each key is read/forwarded only when its own sub-form saved — one sub-form, one atomic save. The
  // service trims + treats blank as "not configured" (removes the key) and MERGES the forwarded keys onto
  // what is stored (read-then-patch-then-write), so saving one rule's message never clobbers the other's.
  // Custom apply-time message (feedback 9d8cf621): its own sub-form posts `applyNotice=1` (marker) plus an
  // "Enable custom message" checkbox + the message textarea. When the checkbox is unchecked the textarea is
  // hidden and we forward an empty string ⇒ the merge in updateLeaveType removes the key (message disabled);
  // a non-empty string stores the notice shown to employees on the leave apply form. Rides the SAME shared
  // customMessages JSONB + merge convention as the two block messages, so saving one never clobbers the others.
  const touchApplyNotice = fd.get('applyNotice') === '1';
  const applyNoticeEnabled = fd.get('enableApplyNotice') === 'on';
  const customMessageFields =
    touchBackdating || touchMinAdvance || touchApplyNotice
      ? {
          customMessages: {
            ...(touchBackdating ? { backdatingLimitDays: String(fd.get('customMessageBackdating') ?? '').trim() } : {}),
            ...(touchMinAdvance ? { minAdvanceDays: String(fd.get('customMessageMinAdvance') ?? '').trim() } : {}),
            ...(touchApplyNotice
              ? { applyNotice: applyNoticeEnabled ? String(fd.get('customMessageApplyNotice') ?? '').trim() : '' }
              : {}),
          },
        }
      : {};
  // r301 (board 83511d3b) — Cancel Approved Leave: its own card posts `cancelApproved=1` (marker), the
  // `employeeCancelApproved` switch and — ONLY while the switch is ticked, because the card renders them only
  // then — the notice days, the approval choice and the notify box. So: marker absent ⇒ nothing forwarded (any
  // other card's save leaves all four columns alone); switch off ⇒ only the switch is written, and the three
  // settings stay as they were (a checkbox or select the card did not render is NOT read as off); switch on ⇒
  // all four. A blank notice means 0 (no minimum notice). The service validates the figure and refuses
  // automatic approval on Replacement Leave.
  const touchCancelApproved = fd.get('cancelApproved') === '1';
  const cancelApprovedOn = fd.get('employeeCancelApproved') === 'on';
  const cancelNoticeRaw = String(fd.get('cancelNoticeDays') ?? '').trim();
  const cancelApprovedFields: {
    employeeCancelApproved?: boolean;
    cancelNoticeDays?: number;
    cancelAutoApprove?: boolean;
    cancelNotify?: boolean;
  } = !touchCancelApproved
    ? {}
    : cancelApprovedOn
      ? {
          employeeCancelApproved: true,
          cancelNoticeDays: cancelNoticeRaw === '' ? 0 : Number(cancelNoticeRaw),
          cancelAutoApprove: fd.get('cancelApproval') === 'auto',
          cancelNotify: fd.get('cancelNotify') === 'on',
        }
      : { employeeCancelApproved: false };
  const leaveTypeId = String(fd.get('id'));
  try {
    await updateLeaveType(s, {
      id: leaveTypeId,
      name: String(fd.get('name') ?? '').trim(),
      ...identityFields,
      eligibility,
      probationEligibility,
      durations,
      ...docFields,
      ...payrollFields,
      ...requestRuleFields,
      ...partialFields,
      ...duplicatePolicyFields,
      ...negativeBalanceFields,
      ...balanceSourceFields,
      ...allowUplFields,
      ...essViewFields,
      ...formulaFields,
      ...dayTypeInclusionFields,
      ...overrideRulesFields,
      ...visualFields,
      ...leaveUnitFields,
      ...yearCycleFields,
      ...visibilityFields,
      ...placementFields,
      ...customMessageFields,
      ...cancelApprovedFields,
      // 4ec5a940 — optional "why the change was made" note, recorded on the audit event.
      reason: String(fd.get('reason') || '') || null,
    });
  } catch (e) {
    // Edit Leave Type Code (a7194511): the identity/rename form lives on the Entitlements tab (the per-type
    // config panel), so a failed save — e.g. the duplicate-code / statutory-lock validation — returns there so
    // HR sees the error banner + toast without being bounced off the page. (No #type anchor here: fail() appends
    // ?error=, and a fragment before the query string would swallow it.) Other sub-forms keep the LEAVE target.
    // Stay-on-page keystone (b9dac2d1): the per-type config panel lives on the Entitlements tab, so EVERY
    // sub-form save — not just identity/rename — must return there on failure with the error banner + toast,
    // rather than bouncing HR to /admin/leave. (No #type anchor here: fail() appends ?error=, and a fragment
    // before the query string would swallow it.)
    //
    // 464b58e6 — A DRIVER ERROR IS NOT A MESSAGE FOR HR. fail() puts (e as Error).message straight into
    // ?error=, and drizzle wraps a failed statement as `Failed query: <the entire SQL>\nparams: …`
    // (node_modules/drizzle-orm/errors.js) — which is the "Failed to query" banner the reporter photographed.
    // There is nothing in it HR can act on, and a SQL statement has no business in a URL or on a screen.
    // Domain refusals are UNTOUCHED and still surface verbatim: the statutory-apply guard, the duplicate
    // name/code messages and the closed-set validations are all written for HR to read. Only a driver-shaped
    // message is swapped, and it is logged in full server-side first, so nothing is lost — least of all the
    // failure itself, which still stops the save and still says so.
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.startsWith('Failed query:')) {
      console.error('updateLeaveTypeAction — database error while saving a leave type:', e);
      const tErr = await getTranslations('admin.leave');
      fail(ENTITLEMENTS, new Error(tErr('saveDatabaseError')));
    }
    fail(ENTITLEMENTS, e);
  }
  // Stay-on-page keystone (b9dac2d1): on ANY successful sub-form save, stay on the Entitlements config panel,
  // surface a success toast, and preserve the #type-<id> anchor so the edited row re-expands and stays in view
  // (requirement: "display a success message and remain on the current page without redirecting"). The
  // identity/rename save keeps its own leave-type-specific toast; all other sub-forms get the generic "saved".
  const t = await getTranslations('admin.leave');
  revalidatePath(ENTITLEMENTS);
  redirect(
    `${ENTITLEMENTS}?toast=${encodeURIComponent(t(touchIdentity ? 'codeSavedToast' : 'savedToast'))}#type-${leaveTypeId}`,
  );
}
export async function archiveLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  try { await archiveLeaveType(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(LEAVE, e); }
  ok(LEAVE);
}
export async function deleteLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  try { await deleteLeaveType(s, { id: String(fd.get('id')) }); } catch (e) { fail(LEAVE, e); }
  ok(LEAVE);
}

// ADR-0033 33-4 — run the TOIL expiry sweep for today (manual; a scheduled job will do this later).
//
// requireAdmin(), not getSession() (ADR-0077 slice 3 review). Until slice 3 the service's first line was
// `if (!toilEnabled()) throw`, which was doing duty as the only check on this path — and since
// TOIL_ENABLED is set in no tracked env file it refused everyone. Slice 3 removed that gate deliberately
// (a lapsed entitlement must not strand a settlement the employer already owes), which left a mutating
// statutory sweep behind a bare session on a directly-POSTable server action. Same correction as
// openLeaveYearAction above. The service asserts it too — a redirect is a UX gate, not authority.
export async function runToilExpiryAction() {
  const s = await requireAdmin();
  const today = todayInKualaLumpur();
  let result;
  try {
    result = await runToilExpiry(s, { today });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  revalidatePath(TOIL_POLICY);
  // `skipped` carries core/toil.ts's `skippedOutOfScope` to the banner. Dropping it here would put the
  // partial-sweep signal back where it was: a company-scoped admin would see the same success banner
  // whether nothing was due or another company's statutory settlements were silently left behind.
  redirect(
    `${TOIL_POLICY}?processed=${result!.processed}&converted=${result!.converted}&lapsed=${result!.lapsed}` +
      `&skipped=${result!.skippedOutOfScope}`,
  );
}

// RL Control Engine (0113) — year-end rollover: expire (or carry-forward, per each accrual's frozen flag) the
// replacement-leave balance at the year boundary. Supervised admin click; no cron. `asOf` defaults to this
// year's 31 Dec for calendar tenants (the service recomputes per-employment boundaries for anniversary).
// requireAdmin() for the reason given on runToilExpiryAction, and more sharply here: this writes a
// `replacement-leave-year.closed` marker, and `domain_event` has UPDATE/DELETE REVOKEd from ai_hr_app, so
// a marker written by the wrong caller cannot be undone through the product.
export async function closeReplacementLeaveYearAction() {
  const s = await requireAdmin();
  const asOf = `${new Date().getUTCFullYear()}-12-31`;
  let result;
  try {
    result = await closeReplacementLeaveYear(s, { asOf });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  revalidatePath(TOIL_POLICY);
  redirect(
    `${TOIL_POLICY}?closed=1&closedAlready=${result!.alreadyClosed ? 1 : 0}&closedProcessed=${result!.processed}` +
      `&closedConverted=${result!.converted}&closedLapsed=${result!.lapsed}&closedCarried=${result!.carriedForward}`,
  );
}

// ADR-0033 33-5 — upsert one company's TOIL (leave-in-lieu) policy. Checkboxes ⇒ presence test.
//
// 296fc027: the form this serves MOVED to /admin/leave/replacement, so every redirect target moved with
// it. The action itself did not move — it stays here beside the two sweep actions it is related to, and
// beside `fail`/`ok`, which is what the plan asked for ("move the policy editor form and its
// setToilPolicyAction TARGET"). Redirecting to the old page would have landed the admin on a screen that
// no longer shows the form they just submitted, with their validation error invisible.
//
// 20e759a0 — THE PAGE IS NOW FILTERED TO ONE COMPANY (`?company=`), so every return path out of this
// action has to carry that selection back. It did not, and all three targets dropped it: `saved=1`, the
// premium-equivalent `warning=`, and `fail(LEAVE_REPLACEMENT, e)` on the error path. The consequence is
// worst on the error path — the admin is thrown onto the DEFAULT company's form, where the `?error=`
// banner describes a validation failure in a form that is no longer on screen.
//
// The id comes off the FormData, from the hidden `companyId` input the form already posts, so there is
// nothing new for the page to send. Saving from the "All companies" view therefore lands on the company
// whose Save was pressed rather than back on the stacked list — that is the company being edited, and it
// is where the saved/error banner belongs.
//
// `fail()` cannot be used any more: it appends `?error=` to whatever path it is given, so passing it a
// path that already carries `?company=` would produce two `?`. The redirect is built here instead.
export async function setToilPolicyAction(fd: FormData) {
  const s = await getSession();
  const companyId = String(fd.get('companyId') ?? '');
  const back = (params: string) =>
    `${LEAVE_REPLACEMENT}?${params}${companyId ? `&company=${encodeURIComponent(companyId)}` : ''}`;
  let warning: string | undefined;
  try {
    // 296fc027 — the eligibility criteria, read the way every other multi-select criteria form in this
    // codebase is read: one repeated hidden input per selected value, under the criterion's own key,
    // pulled back with getAll. No JSON round-trip. The key IS the stored JSONB key by construction
    // (core/replacement-eligibility.ts), so this loop needs no per-field wiring and cannot drift from the
    // picker. `setToilPolicy` normalises the result (dedupe, drop blanks, all-empty ⇒ NULL).
    const requestEligibility: ReplacementRequestEligibility = {};
    for (const c of REPLACEMENT_ELIGIBILITY_CRITERIA) {
      requestEligibility[c.key] = fd.getAll(c.key).map(String);
    }
    // Phase-B #14: premium_equivalent + allowing First-Schedule staff returns a banking-risk warning.
    const r = await setToilPolicy(s, {
      companyId,
      enabled: fd.get('enabled') === 'on',
      accrualBasis: String(fd.get('accrualBasis') ?? 'hours_worked') as ToilAccrualBasis,
      expiryDays: Number(fd.get('expiryDays') ?? 90),
      onExpiry: String(fd.get('onExpiry') ?? 'convert_to_pay') as ToilExpiryAction,
      allowFirstScheduleEligible: fd.get('allowFirstScheduleEligible') === 'on',
      autoAccrueOnApproval: fd.get('autoAccrueOnApproval') === 'on',
      carryForwardAtYearEnd: fd.get('carryForwardAtYearEnd') === 'on',
      // Both counts are posted on every save regardless of which unit is selected, so flipping the unit
      // and flipping back does not lose the other count — see the two-column note in migration 0380.
      expiryUnit: String(fd.get('expiryUnit') ?? 'days') as ToilExpiryUnit,
      expiryMonths: Number(fd.get('expiryMonths') ?? 3),
      employeeRequestEnabled: fd.get('employeeRequestEnabled') === 'on',
      // 3fb1a611 (r299) — NOT POSTED ANY MORE: the Rules tab dropped "Replacement leave from" (nothing reads
      // it), so an absent field is passed as undefined and setToilPolicy keeps the stored value rather than
      // resetting it to the default on every save. A form that still posts it still sets it.
      replacementLeaveFrom: fd.has('replacementLeaveFrom')
        ? (String(fd.get('replacementLeaveFrom')) as ToilReplacementLeaveFrom)
        : undefined,
      requestEligibility,
      // r334 928f0454 — the extended-hours block. A checkbox is read by PRESENCE (the form posts nothing when
      // it is off), and the four numbers are read with the same defaults `setToilPolicy` and the column
      // defaults use, so a caller that somehow omits them writes the pre-r334 policy rather than NaN.
      extendedHoursEnabled: fd.get('extendedHoursEnabled') === 'on',
      extendedHalfDayMinutes: Number(fd.get('extendedHalfDayMinutes') ?? 240),
      extendedFullDayMinutes: Number(fd.get('extendedFullDayMinutes') ?? 480),
      extendedBreakMinutes: Number(fd.get('extendedBreakMinutes') ?? 0),
      extendedGraceMinutes: Number(fd.get('extendedGraceMinutes') ?? 0),
    });
    warning = r.premiumEquivalentWarning;
  } catch (e) {
    redirect(back(`error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(LEAVE_REPLACEMENT);
  // The warning has been produced since Phase-B #14 but the old target never read the param, so it was
  // dropped on every save. The new page renders it.
  redirect(warning ? back(`warning=${encodeURIComponent(warning)}`) : back('saved=1'));
}

// ADR-0069 — upsert one company's leave encashment policy (Company Leave Settings -> Encashment Policy).
// Checkboxes ⇒ presence test (mirrors setToilPolicyAction).
export async function setLeaveEncashmentPolicyAction(fd: FormData) {
  const s = await getSession();
  try {
    await setEncashmentPolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      enabled: fd.get('enabled') === 'on',
      autoFreeze: fd.get('autoFreeze') === 'on',
    });
  } catch (e) {
    // a6fe37fc ROUND 5 (cutover) — RETURNS TO COMPANY RULES. The encashment policy was on Payroll impact
    // and is on Company rules now (IA §2.0.3, F40); returning to the leave TYPE screen would leave the
    // administrator looking at a list that does not contain what they just saved.
    fail(COMPANY_RULES, e);
  }
  ok(COMPANY_RULES);
}

// ADR-0032 C7 — upsert one company's attendance policy (the no-roster default schedule).
// Feedback 31474452: the page posts one dayType_<1..7> select ("full" | "half" | "rest") per ISO weekday
// instead of a plain workingDays checkbox list — decode those into the two arrays the service expects.
export async function setAttendancePolicyAction(fd: FormData) {
  const s = await getSession();
  /**
   * 6d091cc0 (r301) — WHERE THE SAVE LANDS: the Schedule screen, always, as a PLAIN path.
   *
   * r287 mapped a hidden `returnTo` through a two-entry closed list, because the form had two mounts. It has one
   * now (see SCHEDULE_TAB above), so there is nothing left to choose between and nothing is read from the request
   * body to decide it — which also closes the open-redirect question for good. The General tab is the default
   * tab, so no `?tab=` is needed; adding one is exactly the defect that hid every refusal (see SCHEDULE_TAB).
   */
  const backTo = SCHEDULE_TAB;
  const workingDays: number[] = [];
  const halfWorkingDays: number[] = [];
  for (let d = 1; d <= 7; d++) {
    const v = fd.get(`dayType_${d}`);
    if (v === 'full') workingDays.push(d);
    else if (v === 'half') halfWorkingDays.push(d);
  }
  // ADR-0069 + 7c834696: how an approved overtime request's minutes are resolved
  // (requested | system_calculated | smaller_of | greater_of). Anything unrecognised falls back to the
  // default rather than throwing — this is a select, not free text.
  const otRaw = String(fd.get('otApprovalCalculation') ?? 'system_calculated');
  const otApprovalCalculation = (
    otRaw === 'requested' || otRaw === 'smaller_of' || otRaw === 'greater_of' ? otRaw : 'system_calculated'
  ) as 'requested' | 'system_calculated' | 'smaller_of' | 'greater_of';
  try {
    await setAttendancePolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      workStart: String(fd.get('workStart') ?? ''),
      workEnd: String(fd.get('workEnd') ?? ''),
      breakMinutes: Number(fd.get('breakMinutes') ?? 0),
      lateAfter: String(fd.get('lateAfter') ?? ''),
      halfDayBefore: String(fd.get('halfDayBefore') ?? ''),
      workingDays,
      halfWorkingDays,
      otApprovalCalculation,
      // Feedback 5249d43f: registered-device enforcement checkbox (absent when unchecked ⇒ false).
      requireRegisteredDevice: fd.get('requireRegisteredDevice') != null,
    });
  } catch (e) {
    fail(backTo, e);
  }
  ok(backTo);
}

// ADR-0054 — Location master data CRUD. requireAdmin gates the route; RLS gates the write per company.
/**
 * 639bf4a5 rev 2 (r338) — EVERY WAY OUT OF A LOCATION SCREEN, and the two that a refusal takes.
 *
 * The four writes below used to be posted from strips on the register itself, so "where does this land"
 * had one answer: the register. The register is a COMPANY LISTING now and carries no form at all — Add,
 * View and Edit each open a screen of their own — so each write has to land somewhere the operator can
 * see the result of it:
 *   saved   → THE LISTING, as they left it, landed on the row they just saved and highlighted
 *             (`?saved=1&focus=<id>#row-<id>`, the r265 idiom the clocking screens already use).
 *   refused → THE SCREEN THE FORM WAS ON, `error=<reason>` beside the fields, plus everything typed
 *             echoed under the `typed*` keys of ./work-locations/location-fields.ts — so the screen
 *             re-renders the operator's own values rather than what is on file.
 *
 * ⚠️ THE SCREEN IS DERIVED FROM A POSTED ID, NEVER FROM A POSTED URL. A refusal on Add goes to
 * `LOCATION_NEW_PAGE?companyId=<posted companyId>` and one on Edit to `locationEditPage(<posted
 * locationId>)`, each shape-checked as a uuid FIRST — junk gets the plain listing with the reason, the
 * same rule the clocking actions are held to (test/clocking-location-page.test.ts).
 *
 * ⚠️ `returnTo` IS POSTED AND IS UNTRUSTED, and it is the ONE thing here that comes from the browser as
 * a path. It is whitelisted BY SHAPE through lib/return-to.ts `workLocationsReturnTo`: a value that is
 * not `/admin/work-locations` or a path under it falls back to the listing, so no scheme, host or
 * protocol-relative form survives. It carries the listing's own `saved` / `focus` so Cancel and Back
 * land the operator back exactly where they were standing.
 */
function locationReturnTo(fd: FormData): string {
  return workLocationsReturnTo(fd.get('returnTo'));
}

/** A refusal onto a screen that may already carry a query — `fail()` concatenates `?error=` and cannot. */
function failLocationTo(page: string, message: string): never {
  redirect(withQueryParam(page, 'error', message));
}

/** The four fields as posted, raw strings — what the service is given AND what a refusal echoes back. */
function locationFieldsOf(fd: FormData): LocationFormValues {
  const out = {} as LocationFormValues;
  for (const field of LOCATION_FIELDS) out[field] = String(fd.get(field) ?? '');
  return out;
}

/**
 * 1fff489c — the duplicate banner. core/location.ts turns a 23505 on either partial unique index into a
 * typed error (the shiftUniqueError pattern); the SENTENCE is composed here, because only this layer can
 * reach getTranslations. Without it the admin saw drizzle's "Failed query: update "location" set "code" =
 * $1 … params: TWO,Two,MY,,BUKIT JALIL,…" — SQL and parameter values — which is what the reporter's
 * screen actually showed.
 */
async function locationRefusalMessage(e: unknown): Promise<string> {
  if (e instanceof LocationCodeTakenError) {
    const t = await getTranslations('admin.locations');
    return t('codeTaken', { code: e.code });
  }
  if (e instanceof LocationBranchTakenError) {
    const t = await getTranslations('admin.locations');
    // conflictCode is null only if the holding row vanished between the failure and the follow-up read.
    return e.conflictCode
      ? t('branchTaken', { branch: e.branch, code: e.conflictCode })
      : t('branchTakenNoCode', { branch: e.branch });
  }
  return (e as Error).message;
}

/** Refused: back onto the screen the form was on, the reason beside the fields, everything typed echoed. */
async function locationRefused(page: string, typed: LocationFormValues, returnTo: string, e: unknown): Promise<never> {
  const params = new URLSearchParams();
  params.set('error', await locationRefusalMessage(e));
  params.set('from', returnTo);
  for (const field of LOCATION_FIELDS) params.set(typedLocationKey(field), typed[field]);
  redirect(`${page.includes('?') ? page + '&' : page + '?'}${params.toString()}`);
}

export async function createLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const typed = locationFieldsOf(fd);
  const returnTo = locationReturnTo(fd);
  const companyId = String(fd.get('companyId') ?? '').trim();
  // The Add screen for a company that is not one — there is no such screen, so the reason lands on the
  // listing instead of a path built out of whatever was posted.
  const refusalPage = UUID_RE.test(companyId) ? `${LOCATION_NEW_PAGE}?companyId=${companyId}` : returnTo;
  let created: { id: string } | null = null;
  try {
    created = await createLocation(user, {
      companyId,
      code: typed.code,
      name: typed.name,
      country: typed.country || undefined,
      // ADR-0086 (0fe1ca2e, r331) — a `state` field was posted here too. `location.state` is no longer read
      // by anything, so the register stopped offering the control; a new site simply has no state. The
      // service still accepts and validates one (core/location.ts `cleanState`) for its own callers.
      // ADR-0086 — a `holidayGroupId` field was posted here and is retired with
      // `location.holiday_group_id` (migration 0484). A site is no longer one of the ways a holiday
      // calendar is chosen; `employment.holiday_group_id` is.
      // 1fff489c — the Branch this location serves. Blank = not mapped (the field is optional).
      branch: typed.branch || null,
    });
  } catch (e) {
    await locationRefused(refusalPage, typed, returnTo, e);
  }
  revalidatePath(LOCATIONS);
  redirect(locationSavedHref(returnTo, created!.id));
}

export async function updateLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const typed = locationFieldsOf(fd);
  const returnTo = locationReturnTo(fd);
  const locationId = String(fd.get('locationId') ?? '').trim();
  if (!UUID_RE.test(locationId)) failLocationTo(returnTo, 'Location not found');
  try {
    await updateLocation(user, {
      locationId,
      code: typed.code,
      name: typed.name,
      country: typed.country || undefined,
      // ⚠️ ADR-0086 — `state` is DELIBERATELY NOT PASSED, not passed as null. The form no longer has the
      // field, so `fd.get('state')` is null, and `|| null` turned "the operator did not touch it" into
      // "clear it" — wiping the stored state on the first unrelated rename. `updateLocation` reads an
      // absent `state` as "keep"; see the note on that line for why the column is worth keeping.
      branch: typed.branch || null,
    });
  } catch (e) {
    await locationRefused(locationEditPage(locationId), typed, returnTo, e);
  }
  revalidatePath(LOCATIONS);
  redirect(locationSavedHref(returnTo, locationId));
}

export async function archiveLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const returnTo = locationReturnTo(fd);
  try {
    await archiveLocation(user, { locationId: String(fd.get('locationId') ?? '') });
  } catch (e) {
    failLocationTo(returnTo, (e as Error).message);
  }
  revalidatePath(LOCATIONS);
  redirect(returnTo);
}

export async function restoreLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const returnTo = locationReturnTo(fd);
  try {
    await restoreLocation(user, { locationId: String(fd.get('locationId') ?? '') });
  } catch (e) {
    failLocationTo(returnTo, (e as Error).message);
  }
  revalidatePath(LOCATIONS);
  redirect(returnTo);
}

// ADR-0070 — Clocking Location Management CRUD. requireAdmin gates the route. f9afd1ce (0459): a clocking
// location is a SHARED, tenant-level record with no owner company, so there is no companyId on create and
// the WRITE is a group administrator's — the service's assertGroupAdmin throws a plain-English refusal
// that reaches the banner, and RLS (app.is_group_admin() on INSERT/UPDATE/DELETE) says the same thing
// underneath. Assigning a site to an employee (personnel actions) is unchanged.
//
// f9afd1ce rev 2 (r267) — THE FORM LIVES ON A PAGE OF ITS OWN NOW (app/admin/work-locations/clocking/new and
// …/clocking/[id]); the list renders no inline forms. WHERE A SAVE LANDS, the r265 schedule-assignment idiom:
//   saved   → the LIST with `saved=1`, `focus=<id>` and the `#row-<id>` fragment — the administrator lands
//             on the row they just saved, highlighted, not at the top. A radius advisory (1fff489c) rides
//             along as `toast=`, read by the same global ToastFromQuery that read it before: the write
//             already SUCCEEDED, an unusual radius is a warning, never a refusal.
//   refused → the PAGE the form was on, `error=<reason>` beside the fields, plus EVERYTHING typed echoed
//             under the `typed*` keys of app/admin/work-locations/clocking/form-fields.ts (blank included — on
//             the new page "what is on file" is nothing, and a link the operator cleared must not come back
//             pre-picked), so the page re-renders the operator's own values rather than what is on file.
//             The page shape-checks each echoed value before rendering it.
// THE PAGE IS DERIVED FROM THE POSTED ID, NEVER FROM A POSTED URL. `clockingLocationId` is an untrusted
// posted field addressing a uuid column: it is shape-checked here, BEFORE any query, and a malformed one
// lands on the list with the service's own "not found" sentence — there is no page for an id that is not
// one. No redirect below can leave the Locations screens (test/clocking-location-page.test.ts).

/** The eight fields as posted, raw strings — what the service is given AND what a refusal echoes back. */
function clockingFieldsOf(fd: FormData): ClockingFormValues {
  const out = {} as ClockingFormValues;
  for (const field of CLOCKING_FIELDS) out[field] = String(fd.get(field) ?? '');
  return out;
}

/** A posted coordinate: blank must reach the service's "must be a number", not become 0 (Number('') is 0). */
const coord = (v: string): number => (v.trim() === '' ? NaN : Number(v));

/**
 * The refusal, in the admin's language where the service has a typed error for it. The duplicate-name
 * sentence (unique per TENANT since 0459) is composed here because only this layer can reach
 * getTranslations; the service's other refusals already read as sentences and are shown verbatim.
 */
async function clockingRefusalMessage(e: unknown): Promise<string> {
  if (e instanceof ClockingLocationNameTakenError) {
    const t = await getTranslations('admin.locations');
    return t('clockingNameTaken', { name: e.siteName });
  }
  return (e as Error).message;
}

/** Refused: back onto the page the form was on, the reason beside the fields, everything typed echoed. */
async function clockingRefused(page: string, typed: ClockingFormValues, e: unknown): Promise<never> {
  const params = new URLSearchParams();
  params.set('error', await clockingRefusalMessage(e));
  for (const field of CLOCKING_FIELDS) params.set(typedKey(field), typed[field]);
  redirect(`${page}?${params.toString()}`);
}

/**
 * Saved: the point's HOME, landed on its row, highlighted; a radius advisory rides along as the toast it
 * always was.
 *
 * 639bf4a5 rev 2 (r338) — HOME USED TO BE THE REGISTER and is now the LOCATION the point hangs off (or,
 * for a point that hangs off none, the screen that holds exactly those). The register is a company
 * listing and renders no point rows, so `#row-<pointId>` there would have been a dead anchor over a
 * table of companies — the operator would have been told "saved" and shown nothing they just saved.
 *
 * ⚠️ DERIVED FROM THE POSTED `locationId`, NEVER FROM A POSTED URL. That field is one of the eight the
 * clocking form already posts and the service already validates; `clockingPointBase` shape-checks it and
 * falls back to the unlinked screen. So this stays a destination the RECORD implies, which is what
 * test/clocking-location-page.test.ts requires of these two actions.
 */
async function clockingSaved(id: string, locationId: string, warning: RadiusAdvisory | null): Promise<never> {
  const home = clockingPointBase(locationId);
  revalidatePath(home);
  const params = new URLSearchParams({ saved: '1', focus: id });
  if (warning) {
    const t = await getTranslations('admin.locations');
    params.set(
      'toast',
      warning.code === 'tight'
        ? t('radiusWarningTight', { radius: warning.radiusM })
        : t('radiusWarningWide', { radius: warning.radiusM }),
    );
  }
  redirect(`${home}?${params.toString()}#row-${id}`);
}

export async function createClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const typed = clockingFieldsOf(fd);
  let saved: ClockingLocationWriteResult | null = null;
  try {
    saved = await createClockingLocation(user, {
      name: typed.name,
      lat: coord(typed.lat),
      lng: coord(typed.lng),
      // 1fff489c — the radius is REQUIRED by the service, passed as the raw form string so a blank field
      // reaches the "Radius is required" message rather than becoming NaN. f9afd1ce — the location link
      // is OPTIONAL; a blank select posts '' and the service stores null. rev 2 — so is the report label.
      radiusM: typed.radiusM,
      locationId: typed.locationId,
      address: typed.address || null,
      remarks: typed.remarks || null,
      reportLabel: typed.reportLabel || null,
    });
  } catch (e) {
    await clockingRefused(CLOCKING_NEW_PAGE, typed, e);
  }
  // clockingRefused never returns; a refusal has already redirected.
  await clockingSaved(saved!.id, typed.locationId, saved!.warning);
}

export async function updateClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const clockingLocationId = String(fd.get('clockingLocationId') ?? '').trim();
  if (!UUID_RE.test(clockingLocationId)) fail(LOCATIONS, new Error('Clocking location not found'));
  const typed = clockingFieldsOf(fd);
  let saved: ClockingLocationWriteResult | null = null;
  try {
    saved = await updateClockingLocation(user, {
      clockingLocationId,
      name: typed.name,
      lat: coord(typed.lat),
      lng: coord(typed.lng),
      radiusM: typed.radiusM,
      locationId: typed.locationId,
      address: typed.address || null,
      remarks: typed.remarks || null,
      reportLabel: typed.reportLabel || null,
    });
  } catch (e) {
    await clockingRefused(clockingEditPage(clockingLocationId), typed, e);
  }
  await clockingSaved(clockingLocationId, typed.locationId, saved!.warning);
}

/**
 * 639bf4a5 rev 2 (r338) — the three row controls land back on the SCREEN THE ROW WAS ON, which is the
 * location's Edit screen (or the unlinked-points screen). Same derivation as `clockingSaved`: the row
 * posts the `locationId` it was rendered under, `clockingPointBase` shape-checks it, and a junk or
 * absent value collapses to the unlinked screen. No posted URL decides anything.
 */
export async function archiveClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const home = clockingPointBase(String(fd.get('locationId') ?? ''));
  try {
    await archiveClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    fail(home, e);
  }
  ok(home);
}

export async function restoreClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const home = clockingPointBase(String(fd.get('locationId') ?? ''));
  try {
    await restoreClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    fail(home, e);
  }
  ok(home);
}

export async function deleteClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const t = await getTranslations('admin.locations');
  const home = clockingPointBase(String(fd.get('locationId') ?? ''));
  try {
    await deleteClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    if (e instanceof ClockingLocationInUseError) {
      fail(home, new Error(t('clockingInUse', { count: e.refs })));
    }
    fail(home, e);
  }
  ok(home);
}

// ── Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b) ──────────────────────────────
// All redirect to the Entitlements tab (where the Benefit Scheme subsection lives). requireAdmin gates the
// route; RLS additionally gates the write (WITH CHECK app.is_admin()).

/**
 * ae5b84d5 — after a scheme-side configuration write COMMITS, true up every covered employee's
 * current-cycle balance (reprojectEntitlementForSchemeCohort loops the idempotent per-employee recalc).
 * Best-effort, following the recalcAfterProfileChange pattern in the personnel actions: the config save
 * has already committed and the recalc self-heals on the next trigger, so a hiccup here must never fail
 * the save the admin just made. Runs AFTER the service's own transaction — never inside it.
 */

function parseBands(fd: FormData): import('@/core/leave-compute').ServiceBand[] {
  const raw = String(fd.get('serviceBands') ?? '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* 9a65f808 — ALL THREE GRADE-GROUP WRITES NOW RETURN TO SYSTEM_LABELS.
 *
 * The editor is on Settings → System Labels → Organisation, beside Job Grades (it was on
 * /admin/leave/approval under f12d77e5, and on the Entitlements screen before that). A redirect left
 * behind is not a cosmetic mismatch: the save would have worked and then thrown the admin onto a screen
 * with no grade-group card to show the result. A failure is worse — `fail()` carries the message in
 * `?error=`, so "this grade group is used by one or more leave approval rules" would surface on a page
 * with no grade-group form to attach it to, while the screen the admin was actually looking at silently
 * reloaded unchanged. The services and the FormData contract are untouched; only where the redirect lands
 * moved, with the card. */
export async function createGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createGradeGroup(s, {
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updateGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    const { gradeIds } = await updateGradeGroup(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
    // 6e9a126e release three — the scheme-cohort true-up is GONE with benefit schemes, and NOTHING here
    // reprojects a balance. That conclusion SURVIVES 9a65f808, but its old reason does not, so do not read
    // the old one back in: a grade group is now an Employee Eligibility axis as well as an approval-routing
    // scope. The reason there is still nothing to reproject is the STORAGE, not the absence of a consumer —
    // an eligibility rule stores the group's member grades, expanded at pick time
    // (lib/grade-group-coverage.ts), never the group. So moving a grade between groups changes approval
    // routing immediately and changes no saved rule's criteria at all: there is no cohort to true up.
    // What it does change is whether a saved rule still covers a WHOLE group, and that is surfaced as
    // drift on the eligibility screen rather than silently rewritten from here. `gradeIds` is still
    // returned by the writer and still used by its own event payload.
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function deleteGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteGradeGroup(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    // The refusal an admin is most likely to meet here — "used by one or more leave approval rules" — is
    // shown on the screen the card now lives on. It names a consequence on ANOTHER screen deliberately:
    // a grade group is shared vocabulary (approval routing AND entitlement eligibility since 9a65f808),
    // so its delete guard cannot be explained without naming a consumer.
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}






// SHARED LEAVE GROUPS (r88, feedback 1ef1cf95) — CRUD for the tenant-level groups that pool several leave
// types under one shared allowance. These replace the scheme-level combined-limit actions (create / update /
// delete / move / group-from-drag), which are gone with the tables they wrote: the reporter rejected the
// Benefit Scheme shape outright, so there is no scheme id on any of these forms and no drag-to-group path.

/** r82a 1ef1cf95 — read the OPTIONAL per-application cap out of a form. An empty box means "no cap", which
 *  is a real answer here and must arrive as null: `Number('')` is 0, so the usual Number(fd.get(...)) shape
 *  would turn "left blank" into a zero-day cap that refuses every application. Trim first so whitespace
 *  reads as blank too. A non-blank, non-numeric value stays NaN and the core validator rejects it loudly. */
function maxDaysPerApplicationFrom(fd: FormData): number | null {
  const raw = String(fd.get('maxDaysPerApplication') ?? '').trim();
  return raw === '' ? null : Number(raw);
}

/** The clash a leave type in two groups would be, rendered as a sentence naming BOTH — the plan's promise
 *  that we "tell you which one rather than silently moving it". Localized here, at the action boundary, the
 *  same way every other typed core error is (the core throws structured data, never a display string). */
async function sharedGroupFailure(e: unknown): Promise<never> {
  const t = await getTranslations('admin.leave.sharedGroup');
  // a6fe37fc ROUND 5 (cutover) — a shared leave group is a TENANT catalogue, not a property of one leave
  // type; it sat at the foot of the Leave types screen and moved to Company rules with the other three
  // company/tenant settings (IA §2.0.3, F3). These messages name the clashing group by name, so landing
  // them on a screen with no group editor on it would show an administrator a sentence about a form they
  // can no longer see.
  //
  // r281 (cdd7500b) — ENTITLEMENTS, not COMPANY_RULES. The reporter asked for the catalogue back on the
  // Leave types screen; it is drawn there at PAGE level, above the per-type workspace and outside it, so
  // it still reads as spanning several types rather than as a property of the selected one. The return
  // address follows the editor, exactly as it did at the cutover and for the same reason.
  if (e instanceof LeaveTypeAlreadyGroupedError) {
    return fail(ENTITLEMENTS, t('errorAlreadyGrouped', { type: e.leaveTypeName, group: e.groupName }));
  }
  if (e instanceof LeaveSharedGroupNameTakenError) {
    return fail(ENTITLEMENTS, t('errorNameTaken', { name: e.groupName }));
  }
  return fail(ENTITLEMENTS, e);
}

export async function createLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createLeaveSharedGroup(s, {
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      maxDaysPerApplication: maxDaysPerApplicationFrom(fd),
      // 46afcc48 — the group's placement on the employee Leave tab. Read BY VALUE from a <select> that is
      // always submitted: reading it by presence would be trap 17 (an always-sent field cannot answer a
      // yes/no question). An absent or tampered value is narrowed to Hidden by the service, not here.
      essPlacement: String(fd.get('essPlacement') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    await sharedGroupFailure(e);
  }
  ok(ENTITLEMENTS);
}

export async function updateLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await updateLeaveSharedGroup(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      maxDaysPerApplication: maxDaysPerApplicationFrom(fd),
      // 46afcc48 — the group's placement on the employee Leave tab. Read BY VALUE from a <select> that is
      // always submitted: reading it by presence would be trap 17 (an always-sent field cannot answer a
      // yes/no question). An absent or tampered value is narrowed to Hidden by the service, not here.
      essPlacement: String(fd.get('essPlacement') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    await sharedGroupFailure(e);
  }
  ok(ENTITLEMENTS);
}

export async function deleteLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteLeaveSharedGroup(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}
