/**
 * r401 — Monolith rollout STEP 4, first slice: the Dashboard (app/page.tsx) and My Profile (app/me/page.tsx),
 * rendered for real in jsdom from the PAGE FUNCTIONS themselves, with every read mocked to a fixture.
 *
 * What is pinned, and why here:
 *  • Monolith renders the boards' structure (docs/design/monolith/reference/P-Dashboard.dc.html,
 *    P-MyProfile.dc.html): a mono kicker over the h1, stat cells, sections headed `01 · Label` in the user's
 *    order, spec-grid figures, status as WORDS.
 *  • TRUTH OVER THE BOARD: the fixture carries distinctive figures, and every number the Monolith header,
 *    cells and sections print must be one of the fixture's values (or a date/position derived from them). A
 *    board figure with no source — "230 in now", "Day 12 streak" — would surface as a stray number.
 *  • Classic renders today's markup for the same data (PageHeader, StatCards, the attendance bar, the punch
 *    Card), and none of the Monolith-only structure.
 *  • The customizer still lists and renders the chosen cards in Monolith, and its numbering follows the order.
 *
 * The theme comes from the one server reader, lib/ui-theme-server.ts (mocked per test), and is ALSO set on
 * <html data-ui-theme> the way the layout writes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';

// ── fixture state, read by the mocks ────────────────────────────────────────────────────────────────────
const fx = vi.hoisted(() => ({
  theme: 'monolith' as 'monolith' | 'classic',
  admin: true,
  selected: [] as string[],
  extraCards: [] as { cardKey: string; name: string; cardType: 'information' | 'action' | 'shortcut'; href: string | null }[],
}));
const DAY = 86_400_000;
const now = new Date();
const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const STATS = {
  headcount: 417,
  pendingLeave: 23,
  companies: 9,
  departments: 31,
  latestPayroll: { payPeriod: '2026-09', net: '58213.77', status: 'processed' },
  attendance: { date: iso(todayMs - DAY), present: 211, late: 17, halfDay: 4, absent: 13 },
};
const BREAKDOWN = [
  { id: 'c1', name: 'Nusantara Holdings', parentId: null, headcount: 260 },
  { id: 'c2', name: 'Nusantara Retail', parentId: 'c1', headcount: 157 },
];
const HIRES = [
  { employmentId: 'h1', name: 'Marcus Ong', role: 'Engineer', department: 'Engineering', hiredOn: iso(todayMs - 5 * DAY), status: 'active', probationEndsOn: iso(todayMs + 80 * DAY), confirmationDate: null, terminatedOn: null, resignationDate: null, lastWorkingDate: null, blacklisted: false },
  { employmentId: 'h2', name: 'Nurul Izzati', role: null, department: 'Retail', hiredOn: iso(todayMs - 20 * DAY), status: 'active', probationEndsOn: null, confirmationDate: iso(todayMs - 20 * DAY), terminatedOn: null, resignationDate: null, lastWorkingDate: null, blacklisted: false },
];
const EVENTS = [
  { date: iso(todayMs + 12 * DAY), name: 'Deepavali' },
  { date: iso(todayMs + 45 * DAY), name: 'Christmas Day' },
];
const ACTIVITY = [
  { eventType: 'leave_request.submitted', aggregateType: 'leave_request', aggregateId: 'x1', actorType: 'USER', actorName: 'Wei Jie Tan', occurredAt: new Date(now.getTime() - 3 * 3_600_000).toISOString() },
];

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
vi.mock('@/lib/authz', () => ({ isAdmin: vi.fn(() => fx.admin) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ({ tenantId: 't', roles: [] })) }));
vi.mock('@/core/read', () => ({
  // dashboard
  awayTodayCount: vi.fn(async () => 0),
  dashboardStats: vi.fn(async () => STATS),
  groupBreakdown: vi.fn(async () => BREAKDOWN),
  leaveBalances: vi.fn(async () => []),
  listCompanies: vi.fn(async () => []),
  myEmployment: vi.fn(async () => null),
  recentActivity: vi.fn(async () => ACTIVITY),
  recentHires: vi.fn(async () => HIRES),
  reportingLinesFor: vi.fn(async () => null),
  upcomingHolidays: vi.fn(async () => EVENTS),
  // my profile
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
}));
vi.mock('@/core/approvals-inbox', () => ({ pendingApprovalsCount: vi.fn(async () => 0) }));
vi.mock('@/core/dashboard-prefs', () => ({
  getDashboardLayout: vi.fn(async () => ({ selected: fx.selected, order: fx.selected })),
}));
vi.mock('@/core/dashboard-card-config', () => ({
  listDashboardCards: vi.fn(async () => [
    ...fx.selected.map((cardKey, i) => ({
      cardKey,
      name: `Card ${cardKey}`,
      cardType: 'information' as const,
      href: null,
      employeeSelectable: true,
      defaultDisplay: true,
      mandatory: false,
      displayOrder: i + 1,
    })),
    ...fx.extraCards.map((c, i) => ({ ...c, employeeSelectable: true, defaultDisplay: false, mandatory: false, displayOrder: 50 + i })),
  ]),
}));
vi.mock('@/app/dashboard-layout-actions', () => ({ saveDashboardLayoutAction: vi.fn(), resetDashboardLayoutAction: vi.fn() }));
// The real slot is an async server component (its own reads); stand in with the real card it renders.
vi.mock('@/components/notice/notice-surfaces', async () => {
  const { NoticeBoardCard } = await import('../components/notice/notice-board-card');
  return {
    NoticeBoardCardSlot: ({ monolith }: { monolith?: boolean }) => (
      <NoticeBoardCard
        items={[{ id: 'n1', title: 'Office closure', unread: true }]}
        unread={1}
        title="Notice Board"
        emptyLabel="No notices right now."
        viewAllLabel="View all notices"
        newCountLabel="1 new"
        monolith={monolith ? { unreadWord: 'New' } : undefined}
      />
    ),
  };
});
// ── /me only ──
const PAYSLIPS = [
  { id: 'p1', payPeriod: '2026-08', company: 'Nusantara Holdings', gross: '7600', deductions: '926.95', net: '6673.05', status: 'closed', released: true, runType: 'regular', runSeq: 1 },
  { id: 'p2', payPeriod: '2026-09', company: 'Nusantara Holdings', gross: '7700', deductions: '938.14', net: '6761.86', status: 'closed', released: true, runType: 'regular', runSeq: 1 },
];
vi.mock('@/core/loans', () => ({ listLoansForEmployment: vi.fn(async () => []) }));
vi.mock('@/core/profile', () => ({ myProfileChangeRequests: vi.fn(async () => []) }));
vi.mock('@/core/offboarding', () => ({ myResignation: vi.fn(async () => null) }));
vi.mock('@/core/dependents', () => ({ isChildReliefEligible: () => false, childAgeYears: () => null }));
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
vi.mock('@/components/attendance-clock-button', () => ({
  AttendanceClockButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
  LocationNotice: () => null,
}));
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

import DashboardPage from '../app/page';
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
const ADMIN_LAYOUT = [
  'headcount',
  'pendingLeave',
  'companies',
  'latestPayroll',
  'attendanceOverview',
  'headcountByCompany',
  'latestPayrollRun',
  'recentlyJoined',
  'upcomingEvents',
  'recentActivity',
  'noticeBoard',
];
const renderDashboard = async () => wrap(await DashboardPage({ searchParams: Promise.resolve({}) }));
const renderMe = async () => wrap(await MePage({ searchParams: Promise.resolve({}) }));

/** Every number printed in `el`, normalised (commas dropped, leading zeros dropped). */
const numbersIn = (text: string) =>
  [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => {
    const raw = m[0].replace(/,/g, '');
    return raw.includes('.') ? raw : String(Number(raw));
  });
/** Every number in `el`, text node by text node (adjacent elements must not fuse into one figure). */
const numbersInEl = (el: Element) => {
  const out: string[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(...numbersIn(n.textContent ?? ''));
  return out;
};
const t = createTranslator({ locale: 'en', messages });

beforeEach(() => {
  fx.admin = true;
  fx.selected = [...ADMIN_LAYOUT];
  fx.extraCards = [];
});

describe('Dashboard — Monolith', () => {
  beforeEach(() => setTheme('monolith'));

  it('draws the board: a mono kicker over the h1, then the cells, then numbered sections in the user order', async () => {
    const { container } = await renderDashboard();
    const header = container.querySelector('[data-mono-header]') as HTMLElement;
    expect(header, 'the Monolith page header').not.toBeNull();
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(t('dashboard.title'));
    expect(header.querySelector('p')?.textContent).toContain(t('dashboard.overviewAll'));

    const cells = [...container.querySelectorAll('[data-mono-cell]')] as HTMLAnchorElement[];
    expect(cells.map((c) => c.getAttribute('href'))).toEqual(['/personnel', '/leave', '/admin/organization', '/payroll']);
    expect(cells[0]).toHaveTextContent(/HEADCOUNT|Headcount/);
    expect(cells[0].querySelector('b')).toHaveTextContent('417');
    // Pending leave NEEDS someone → signal-text, and said in words by its label.
    expect(cells[1].querySelector('b')).toHaveClass('text-signal-text');
    expect(cells[3].querySelector('b')).toHaveTextContent('RM 58,213.77');

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      `01 · ${t('dashboard.attendance')}`,
      `02 · ${t('dashboard.headcountByCompany')}`,
      `03 · ${t('dashboard.latestPayrollRun')}`,
      `04 · ${t('dashboard.recentlyJoined')}`,
      `05 · ${t('dashboard.upcomingEvents')}`,
      `06 · ${t('dashboard.recentActivity')}`,
      '07 · Notice Board · 1 new',
    ]);
  });

  it('prints figures as a spec grid and status as WORDS (never colour alone)', async () => {
    const { container } = await renderDashboard();
    const attendance = screen.getByRole('region', { name: `01 · ${t('dashboard.attendance')}` });
    const kv = attendance.querySelector('[data-kv]') as HTMLElement;
    expect([...kv.querySelectorAll('dd')].map((d) => d.textContent)).toEqual(['211', '17', '4', '13']);
    expect(within(kv).getByText('17')).toHaveClass('monolith:text-signal-text');
    // Recently joined: the derived Employee Status, as a word.
    const joined = screen.getByRole('region', { name: `04 · ${t('dashboard.recentlyJoined')}` });
    expect(within(joined).getByText('Marcus Ong')).toBeInTheDocument();
    const words = [...joined.querySelectorAll('[data-tone]')].map((w) => w.textContent);
    const labels = Object.values(messages.people.employeeStatus as Record<string, string>);
    expect(words).toHaveLength(2);
    for (const w of words) expect(labels, `"${w}" is an Employee Status word`).toContain(w);
    // Payroll run status is a word, and the notice's unread state is a word too.
    const run = screen.getByRole('region', { name: `03 · ${t('dashboard.latestPayrollRun')}` });
    expect(within(run).getByText('processed')).toHaveAttribute('data-tone', 'signal');
    const notices = screen.getByRole('region', { name: '07 · Notice Board · 1 new' });
    expect(within(notices).getByText('New')).toHaveAttribute('data-tone', 'signal');
    // No Classic leftovers in the Monolith tree.
    expect(container.querySelector('.bg-emerald-500'), 'the Classic attendance bar').toBeNull();
  });

  it('prints NO figure that is not in the data (truth over the board)', async () => {
    const { container } = await renderDashboard();
    const main = container.firstElementChild as HTMLElement;
    const allowed = new Set<string>();
    const add = (...xs: (string | number)[]) => xs.forEach((x) => numbersIn(String(x)).forEach((n) => allowed.add(n)));
    add(JSON.stringify({ STATS, BREAKDOWN, HIRES, EVENTS }));
    add(STATS.headcount); // breakdown total = 260 + 157
    add(12, 45, 5, 3, 60); // in 12 / 45 days, joined 5 days / 3 weeks ago, 3h ago
    for (let i = 1; i <= 7; i++) add(i); // section ordinals
    add(new Date().getFullYear(), new Date().getDate(), new Date(todayMs + DAY).getUTCDate());
    for (const e of [...EVENTS.map((x) => x.date), ...HIRES.map((x) => x.hiredOn)]) add(e.slice(8));
    const shown = numbersInEl(main);
    expect(shown.length, 'the walk saw the figures at all').toBeGreaterThan(20);
    const stray = shown.filter((n) => !allowed.has(n));
    expect(stray, `figures with no source in the fixture: ${stray.join(', ')}`).toEqual([]);
  });

  it('the customizer still lists and renders the chosen cards, and numbering follows the order', async () => {
    fx.selected = ['headcount', 'recentActivity', 'attendanceOverview'];
    fx.extraCards = [{ cardKey: 'upcomingEvents', name: 'Card upcomingEvents', cardType: 'information', href: null }];
    await renderDashboard();
    // The user put Recent activity before Attendance → it is section 01.
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      `01 · ${t('dashboard.recentActivity')}`,
      `02 · ${t('dashboard.attendance')}`,
    ]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t('dashboard.customizeDashboard') })));
    for (const k of fx.selected) expect(screen.getByRole('button', { name: `Reorder Card ${k}` })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t('dashboard.addCard') })));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Card upcomingEvents/ })));
    // The added card renders in the board's language, numbered after the others — live, before saving.
    expect(screen.getByRole('heading', { level: 2, name: `03 · ${t('dashboard.upcomingEvents')}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reorder Card upcomingEvents' })).toBeInTheDocument();
  });
});

describe('Dashboard — Classic renders today’s markup for the same data', () => {
  beforeEach(() => setTheme('classic'));

  it('PageHeader, StatCards, the attendance bar; none of the Monolith structure', async () => {
    const { container } = await renderDashboard();
    expect(container.querySelector('[data-mono-header]')).toBeNull();
    expect(container.querySelector('[data-mono-cell]')).toBeNull();
    expect(container.querySelector('[data-section]'), 'no Monolith Section').toBeNull();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
    expect(h1.nextElementSibling).toHaveTextContent(t('dashboard.overviewAll'));
    // StatCard: the 3xl figure inside a link card.
    const figure = screen.getByText('417');
    expect(figure).toHaveClass('mt-2', 'text-3xl', 'font-semibold', 'tracking-tight', 'tabular-nums');
    expect(figure.closest('a')).toHaveAttribute('href', '/personnel');
    expect(container.querySelector('.bg-emerald-500'), 'the attendance bar').not.toBeNull();
    // Classic headings, no index.
    expect(screen.getByRole('heading', { level: 2, name: t('dashboard.attendance') })).toBeInTheDocument();
    expect(screen.queryByText(/^0\d · /)).toBeNull();
  });
});

describe('My Profile', () => {
  it('Monolith: kicker + h1 + real cells, the punch as a section, the tabs as text buttons', async () => {
    setTheme('monolith');
    const { container } = await renderMe();
    const header = container.querySelector('[data-mono-header]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(t('me.title'));
    expect(header.querySelector('p')).toHaveTextContent('EMP0042 · Aisyah Rahman · Analyst, Finance');
    const cells = container.querySelector('[data-cells]') as HTMLElement;
    const terms = [...cells.querySelectorAll('dt')].map((d) => d.textContent);
    expect(terms).toEqual([t('me.lastPayslip'), t('people.detail.employmentInfo.groupService')]);
    // The NEWEST released payslip (2026-09), not the first row.
    expect(cells).toHaveTextContent('RM 6,761.86');
    expect(cells).toHaveTextContent('2026-09 · Nusantara Holdings');
    // Truth: every number in the header and cells comes from the fixture.
    const allowed = new Set(numbersIn(JSON.stringify({ PAYSLIPS, RECORD })).concat(['5', '7', '19']));
    const stray = [...numbersInEl(header), ...numbersInEl(cells)].filter((n) => !allowed.has(n));
    expect(stray, `figures with no source: ${stray.join(', ')}`).toEqual([]);
    // The punch is still here, as a section, with its action.
    expect(screen.getByRole('region', { name: t('me.todayHeading') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('me.checkIn') })).toBeInTheDocument();
    // Tabs: the same six, the strip drawn as text buttons in Monolith.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    expect(tabs[0].closest('nav')).toHaveClass('monolith:border-b');
    expect(tabs[0]).toHaveClass('monolith:border-ink');
    // A read-only field is a hairline kv value in Monolith, still a disabled unnamed input.
    const code = screen.getByDisplayValue('EMP0042');
    expect(code).toBeDisabled();
    expect(code).not.toHaveAttribute('name');
    expect(code).toHaveClass('monolith:border-b', 'monolith:bg-transparent');
  });

  it('Classic: today’s header and punch card, no Monolith head or cells', async () => {
    setTheme('classic');
    const { container } = await renderMe();
    expect(container.querySelector('[data-mono-header]')).toBeNull();
    expect(container.querySelector('[data-cells]')).toBeNull();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
    expect(h1.nextElementSibling).toHaveTextContent('EMP0042 · Aisyah Rahman · Analyst, Finance');
    const punch = container.querySelector('[data-tour="me-attendance"]') as HTMLElement;
    expect(punch).toHaveClass('p-4');
    expect(within(punch).getByRole('heading', { level: 2 })).toHaveClass('text-sm', 'font-semibold');
    expect(screen.queryByText(t('me.lastPayslip'))).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });
});
