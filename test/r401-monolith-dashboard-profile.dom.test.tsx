/**
 * r401 — Monolith rollout STEP 4: My Profile (app/me/page.tsx), rendered for real in jsdom from the PAGE FUNCTION,
 * with every read mocked to a fixture, in both themes.
 *
 * The Dashboard half of this suite pinned the old dashboard (app/page.tsx `?workspace=dashboard`), which was retired
 * on 12 Nov 2026 (owner decision): `/` now draws the person's own Today, whose routing is pinned in
 * test/employee-home-landing.test.ts.
 *
 * The theme comes from the one server reader, lib/ui-theme-server.ts (mocked per test), and is ALSO set on
 * <html data-ui-theme> the way the layout writes it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';

// ── fixture state, read by the mocks ────────────────────────────────────────────────────────────────────
const fx = vi.hoisted(() => ({
  theme: 'monolith' as 'monolith' | 'classic',
}));
vi.mock('@/lib/ui-theme-server', () => ({ currentUiTheme: vi.fn(async () => fx.theme) }));
vi.mock('next-intl/server', async () => {
  const msgs = (await import('../messages/en.json')).default;
  const { createTranslator: ct } = await import('next-intl');
  return {
    getTranslations: vi.fn(async (namespace?: string) => ct({ locale: 'en', messages: msgs, namespace: namespace as never })),
    getLocale: vi.fn(async () => 'en'),
  };
});
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  usePathname: () => '/',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/db/client', () => ({}));
vi.mock('@/lib/scope', () => ({ scopedSession: vi.fn(async () => ({ s: { tenantId: 't', roles: [] }, scopeIds: ['c1', 'c2'], allowedCount: 2 })) }));
vi.mock('@/lib/authz', () => ({ isAdmin: vi.fn(() => true) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ({ tenantId: 't', roles: [] })) }));
vi.mock('@/core/read', () => ({
  myOwnEmploymentSubjects:vi.fn(async()=>[{employmentId:'e1',company:'Nusantara Holdings',employeeCode:'EMP0042'}]),
  myEmployments: vi.fn(async () => [{ employmentId: 'e1', company: 'Nusantara Holdings', position: 'Analyst', department: 'Finance', basic: '7200', allowance: '400' }]),
  myPayslips: vi.fn(async () => PAYSLIPS),
  myTaxRelief: vi.fn(async () => ({ year: 2026, rows: [], ytd: 0 })),
  myTaxReliefEmploymentIds: vi.fn(async () => ['e1']),
  myEmploymentIdsAll: vi.fn(async () => [{ employmentId: 'e1', company: 'Nusantara Holdings' }]),
  myAttendance: vi.fn(async () => []),
}));
vi.mock('@/core/employment-review', () => ({ pendingManagerReviewsFor: vi.fn(async () => []) }));
vi.mock('@/packs/performance/service', () => ({ myFeedbackRequests: vi.fn(async () => []) }));
vi.mock('@/core/entitlements', () => ({
  isModuleEnabledOrFalse: vi.fn(() => true),
  getSettingOrFallback: vi.fn(() => []),
  getSetting: vi.fn(() => false),
}));
// ── /me only ──
const PAYSLIPS = [
  { id: 'p1', employmentId:'e1', payPeriod: '2026-08', company: 'Nusantara Holdings', gross: '7600', deductions: '926.95', net: '6673.05', status: 'closed', released: true, runType: 'regular', runSeq: 1 },
  { id: 'p2', employmentId:'e1', payPeriod: '2026-09', company: 'Nusantara Holdings', gross: '7700', deductions: '938.14', net: '6761.86', status: 'closed', released: true, runType: 'regular', runSeq: 1 },
];
vi.mock('@/core/loans', () => ({ listLoansForEmployment: vi.fn(async () => []) }));
// The real admin/eligibility import graph consumes these same client-safe vocabulary identities.
// Keep the backend read mocked; do not import the actual database-backed profile module.
vi.mock('@/core/profile', async () => {
  const {GENDERS,MARITAL_STATUSES}=await import('../lib/person-vocabulary');
  return {GENDERS,MARITAL_STATUSES,myProfileChangeRequests:vi.fn(async()=>[])};
});
vi.mock('@/core/offboarding', () => ({ myResignation: vi.fn(async () => null) }));
// core/profile-options reads the dependents vocabulary at module load, so the mock carries the real
// client-safe vocabulary and the category key (core/dependents re-exports both) beside its two stubs.
vi.mock('@/core/dependents', async () => ({
  ...(await import('../lib/dependent-vocabulary')),
  DEPENDENT_RELATIONSHIP_CATEGORY: 'dependentRelationship',
  isChildReliefEligible: () => false,
  childAgeYears: () => null,
}));
vi.mock('@/packs/leave/service', () => ({ serviceYearsMonthsDaysAt: () => ({ years: 5, months: 7, days: 19 }) }));
vi.mock('../app/me/review-card', () => ({ MeReviewCard: () => null }));
vi.mock('../app/me/actions', () => ({
  myCheckIn: vi.fn(),
  myCheckOut: vi.fn(),
  mySubmitResignation: vi.fn(),
  myUpdateContact: vi.fn(),
  myWithdrawResignation: vi.fn(),
}));
vi.mock('../app/me/request-change-card', () => ({ RequestChangeCard: () => null, pendingProposedByKey: () => new Map() }));
// This layout fixture replaces async server slots; correction behavior is tested separately.
vi.mock('../app/me/readiness-work', () => ({ MyReadinessWork: () => null }));
// AI v2 W11: the private-case entry card is an async server component (its own getTranslations), which jsdom cannot
// render; its markup and link have their own DOM test (test/private-cases-screens.dom.test.tsx). A marker stands in
// so this layout still proves My Profile places it.
vi.mock('@/components/private-cases/entry-cards', () => ({ PrivateCaseEntryCard: () => <div data-private-case-entry /> }));
vi.mock('@/components/attendance-clock-button', () => ({
  AttendanceClockButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
  LocationNotice: () => null,
}));
vi.mock('@/core/profile-edit-policy',async()=>{const {resolveEssVisibleIds}=await import('../lib/personnel-ess-visibility');return {readProfilePresentationPolicy:vi.fn(async()=>({ctx:{tenantId:'t',roles:[]},visible:resolveEssVisibleIds('all')}))};});
vi.mock('@/core/profile-edit',()=>({readOwnProfileWorkspace:vi.fn(async()=>({employmentId:'e1',personId:'p1',country:'MY',values:{'profile.personal_details.fullname':'Aisyah Rahman','profile.personal_details.employeecode':'EMP0042'},baselines:{},registers:[],editable:[],legacyPrimaryEditable:[],addressReview:false,legacyAddress:{},statutoryAvailable:true}))}));
vi.mock('@/core/profile-view',()=>({readOwnProfileFacts:vi.fn(async()=>({values:{},records:[],choices:{},service:{group:{years:5,months:7,days:19},company:{years:5,months:7,days:19}},header:{name:'Aisyah Rahman',employeeCode:'EMP0042',company:'Nusantara Holdings',department:'Finance',position:'Analyst',superior:null,status:'active',photo:false,service:{years:5,months:7,days:19}},modules:{payroll:true,leave:true,attendance:true}}))}));
vi.mock('../app/me/profile-edit-actions',()=>({saveMyProfileEditAction:vi.fn(),readMyProfileMovementAction:vi.fn()}));
vi.mock('../app/me/record', () => ({ myProfileRecord: vi.fn(async () => RECORD) }));
const RECORD = {
  employmentId: 'e1',
  personId: 'p1',
  profile: { employeeCode: 'EMP0042', salutation: null, fullName: 'Aisyah Rahman', firstName: null, lastName: null, preferredName: null, nationality: null, religion: null, race: null, gender: 'female', maritalStatus: 'married', dateOfBirth: null, icNumber: null, oldIcNumber: null, passportNumber: null, passportIssueDate: null, passportExpiryDate: null, passportIssuingCountry: null },
  contact: { workEmail: 'aisyah@demo.test', mobilePhone: null, homePhone: null, personalEmail: null, homeAddress: { addressLine1: null, addressLine2: null, addressLine3: null, postcode: null, city: null, state: null, country: null } },
  emergencyContacts: [],
  employment: { company: 'Nusantara Holdings', department: 'Finance', position: 'Analyst', businessUnit: null, employmentType: 'full_time', locationName: null, gradeName: null, employmentCategory: null, orgDivision: null, orgBranch: null, orgRegion: null, orgLine: null, orgSection: null, orgTeam: null, orgBase: null, hiredOn: '2021-03-03', joinDate: null, confirmationDate: null, contractStartDate: null, contractEndDate: null, tenderResignationDate: null, resignationDate: null, lastWorkingDate: null, superiorName: null, superiorCode: null },
  statutory: { bankName: null, bankAccountNo: null, epfNumber: null, epfCitizenship: null, socsoNumber: null, socsoCategory: null, eisCategory: null, taxNumber: null, taxCategory: null, taxCircumstance: null, isResident: null, numChildren: null, disabledIndividual: null, disabledSpouse: null, subjectToHrdf: null },
  compensation: null,
  paymentMethod: null,
  dependents: [],
};

import MePage from '../app/me/page';

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} onError={(e) => { throw e; }}>
      {ui}
    </NextIntlClientProvider>,
  );
const setTheme = (theme: 'monolith' | 'classic') => {
  fx.theme = theme;
  document.documentElement.setAttribute('data-ui-theme', theme);
};
const renderMe = async () => wrap(await MePage({ searchParams: Promise.resolve({}) }));

const t = createTranslator({ locale: 'en', messages });

describe('My Profile approved Personnel alignment in both themes',()=>{
 it.each(['monolith','classic'] as const)('%s retains own summary and eleven tabs, without Today/clocking',async theme=>{
  setTheme(theme);const {container}=await renderMe();
  expect(screen.getByRole('heading',{level:1})).toHaveTextContent(t('me.title'));
  expect(screen.getByRole('heading',{name:'Aisyah Rahman'})).toBeInTheDocument();
  expect(screen.getAllByText('EMP0042').length).toBeGreaterThan(0);expect(screen.getByText('Finance · Analyst')).toBeInTheDocument();
  const tabs=screen.getAllByRole('tab');expect(tabs).toHaveLength(11);expect(tabs[0].closest('nav')).toHaveClass('monolith:border-b');expect(tabs[0]).toHaveClass('monolith:border-ink');
  expect(screen.queryByRole('region',{name:t('me.todayHeading')})).toBeNull();expect(screen.queryByRole('button',{name:t('me.checkIn')})).toBeNull();expect(screen.queryByRole('button',{name:t('me.checkOut')})).toBeNull();
  expect(container.querySelector('input[name="employeeCode"]')).toBeNull();expect(screen.getByRole('link',{name:t('me.viewAttendanceHistory'),hidden:true})).toHaveAttribute('href','/attendance');
  expect(container.querySelectorAll('[data-private-case-entry]')).toHaveLength(1);
 });
});
