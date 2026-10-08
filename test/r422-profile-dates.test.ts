/**
 * r422 (board 7e784380) — "every date in the Personnel Management employee profile displays as DD-MMM-YYYY".
 *
 * THE SWEEP, RENDERED. The profile page (app/admin/personnel/[employmentId]/page.tsx) is called as the async
 * server component it is, against a real employee carrying a date in every register the profile draws
 * (employment dates, salary history, family, qualifications, CP38, pay items, movements, delegations,
 * documents, the probation review), and the element tree it returns is rendered to HTML by React's own
 * server renderer — client components included, exactly as a first page load paints them. The HTML is then
 * parsed and EVERY TEXT NODE is read. No text node may carry a raw yyyy-mm-dd: a date drawn as text goes
 * through lib/date-display.ts. Attributes are deliberately NOT swept: a `<input type="date">` value, a
 * `dateTime=` and an href query string are ISO by contract and are what the server actions read.
 *
 * NON-VACUITY. A sweep over a page that drew no dates passes on nothing, so it also asserts it SAW dates —
 * a minimum count of DD-MMM-YYYY text nodes, and specific dates this fixture wrote (the join date, a
 * dependant's date of birth, the graduation date, the CP38 start) found in their formatted form.
 *
 * Translations are REAL (messages/en.json through next-intl's createTranslator), not key echoes: a date
 * interpolated into a sentence (`t('since', { date })`) is text the reader sees, and an echoing mock would
 * hide it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { session } = vi.hoisted(() => ({ session: { s: null as unknown, scopeIds: [] as string[] } }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/personnel/x',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => session) }));
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: vi.fn(async () => session.s),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('../messages/en.json')).default;
  return {
    getTranslations: vi.fn(async (ns?: string | { namespace?: string }) =>
      createTranslator({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        timeZone: 'Asia/Kuala_Lumpur',
        onError: () => undefined,
      }),
    ),
    getLocale: vi.fn(async () => 'en'),
    getMessages: vi.fn(async () => messages),
    getFormatter: vi.fn(async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' })),
  };
});
vi.mock('next-intl', async (importOriginal) => {
  const real = await importOriginal<typeof import('next-intl')>();
  const messages = (await import('../messages/en.json')).default;
  return {
    ...real,
    useTranslations: (ns?: string) =>
      real.createTranslator({
        locale: 'en',
        messages,
        namespace: ns as never,
        timeZone: 'Asia/Kuala_Lumpur',
        onError: () => undefined,
      }),
    useLocale: () => 'en',
    useFormatter: () => real.createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
    useTimeZone: () => 'Asia/Kuala_Lumpur',
    useMessages: () => messages,
  };
});

import { renderToReadableStream } from 'react-dom/server';
// jsdom ships no type declarations in this repo (no @types/jsdom); the one constructor used is typed here
// against the DOM lib's own Window, which is what it returns.
// @ts-expect-error -- jsdom has no bundled types and @types/jsdom is not installed
import * as jsdomModule from 'jsdom';
const { JSDOM } = jsdomModule as unknown as { JSDOM: new (html: string) => { window: Window & typeof globalThis } };
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { addDependent } from '../core/dependents';
import { addQualification } from '../core/qualifications';
import { addEmergencyContact } from '../core/emergency-contacts';
import { addEmployeeDocument } from '../core/employee-documents';
import { setCp38 } from '../core/cp38';
import { createMovementEvent, movementHistory } from '../core/movement';
import { setEmploymentInfo, setReportingLine } from '../core/org';
import { setPassportProfileMY } from '../localization/my/statutory';
import { requestLeave } from '../core/leave';
import { seedPayComponentCatalog, listPayComponents, setEmploymentPayComponent } from '../core/pay-components';
import { todayInKualaLumpur } from '../lib/hr-date';
import { formatDmy } from '../lib/date-display';
import EmployeePage from '../app/admin/personnel/[employmentId]/page';
import { closeAll, entitledCtx, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ISO = /\b\d{4}-\d{2}-\d{2}\b/;
const DMY = /\b\d{2}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}\b/;


let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const today = todayInKualaLumpur();
const year = Number(today.slice(0, 4));
/** Hired on 15 March two years ago: in the past whatever today is, and a day that reads unambiguously. */
const hiredOn = `${year - 2}-03-15`;
const childDob = `${year - 6}-01-31`;
const graduation = `${year - 8}-07-15`;
const cp38From = `${year - 1}-02-01`;
const confirmedOn = `${year - 2}-09-15`;
const secondFrom = `${year - 1}-05-01`;
const secondTo = `${year - 1}-08-31`;
const marriedOn = `${year - 10}-06-30`;
const passportIssued = `${year - 3}-04-10`;
const passportExpires = `${year + 7}-04-09`;
const payItemFrom = `${year - 1}-03-01`;
const delegationFrom = `${year - 1}-11-01`;
const superiorFrom = `${year - 2}-04-01`;
const superiorTo = `${year - 1}-01-02`;
/** A pending (future) movement: the Employment card lists it with its date. Derived from the clock. */
const pendingOn = `${year + 1}-01-15`;

async function seedEmployee() {
  const a = await entitledCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: 'Aisyah Dates', primaryEmail: 'aisyah.dates@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: hiredOn });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5500,
    monthlyAllowance: 0,
    effectiveFrom: `${year - 1}-01-01`,
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015555' });
  await addDependent(a, {
    personId: e.personId,
    fullName: 'Child Dates',
    relationship: 'child',
    dateOfBirth: childDob,
    childReliefCategory: 'under_18',
    childReliefPercentage: 100,
  } as never);
  await addDependent(a, {
    personId: e.personId,
    fullName: 'Spouse Dates',
    relationship: 'spouse',
    dateOfBirth: `${year - 35}-12-31`,
    // Drawn only inside the Edit dialog, which is not open on a first paint — written so the dialog's
    // DateField carries a value when a reader opens it, not asserted below.
    marriageDate: marriedOn,
  } as never);
  await setPassportProfileMY(a, {
    personId: e.personId,
    passportNumber: 'A1234567',
    passportIssueDate: passportIssued,
    passportExpiryDate: passportExpires,
  } as never);
  await seedPayComponentCatalog(a);
  const component = (await listPayComponents(a))[0];
  await setEmploymentPayComponent(a, {
    employmentId: e.employmentId,
    componentId: component.id,
    amount: 200,
    effectiveFrom: payItemFrom,
  } as never);
  const boss = await hireEmployee(a, {
    person: { fullName: 'Boss Dates', primaryEmail: 'boss.dates@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: `${year - 5}-01-01`,
  });
  await setReportingLine(a, {
    subordinateEmploymentId: e.employmentId,
    managerEmploymentId: boss.employmentId,
    lineType: 'administrative',
    validFrom: superiorFrom,
  } as never);
  // A second superior from a later day CLOSES the first line; only a closed line is Direct Superior history.
  const boss2 = await hireEmployee(a, {
    person: { fullName: 'Boss Two Dates', primaryEmail: 'boss2.dates@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: `${year - 5}-01-01`,
  });
  await setReportingLine(a, {
    subordinateEmploymentId: e.employmentId,
    managerEmploymentId: boss2.employmentId,
    lineType: 'administrative',
    validFrom: superiorTo,
  } as never);
  // The stand-in must hold the same approval level as the delegator (core/org.ts): a peer with no reports.
  const peer = await hireEmployee(a, {
    person: { fullName: 'Peer Dates', primaryEmail: 'peer.dates@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: `${year - 4}-01-01`,
  });
  await setReportingLine(a, {
    subordinateEmploymentId: e.employmentId,
    managerEmploymentId: peer.employmentId,
    lineType: 'delegate',
    validFrom: delegationFrom,
    validTo: null,
  } as never);
  await addQualification(a, {
    employmentId: e.employmentId,
    qualification: 'Bachelor',
    description: 'Accounting degree',
    fromYm: `${year - 12}-09`,
    toYm: `${year - 8}-06`,
    institute: 'University Malaya',
    major: 'Accounting',
    graduationDate: graduation,
  } as never);
  await addEmergencyContact(a, {
    personId: e.personId,
    fullName: 'Mary Tan',
    relationship: 'Mother',
    mobilePhone: '019-9876543',
    priority: 'primary',
  } as never);
  await addEmployeeDocument(a, {
    employmentId: e.employmentId,
    title: 'Signed contract',
    category: 'Contract',
    description: 'Employment agreement',
    fileName: 'contract.pdf',
    mimeType: 'application/pdf',
    content: Buffer.from('%PDF-1.4\n%%EOF'),
  } as never);
  await setCp38(a, { employmentId: e.employmentId, cp38Ref: 'CP38-R422', amount: 150, validFrom: cp38From });
  await setEmploymentInfo(a, { employmentId: e.employmentId, confirmationDate: confirmedOn } as never);
  await createMovementEvent(a, {
    employmentId: e.employmentId,
    kind: 'secondment',
    effectiveDate: secondFrom,
    endDate: secondTo,
    remarks: 'Group project',
  } as never);
  await createMovementEvent(a, {
    employmentId: e.employmentId,
    kind: 'secondment',
    effectiveDate: pendingOn,
    endDate: `${year + 1}-03-31`,
    remarks: 'Future project',
  } as never);
  // A leave request is best-effort: whether the seeded Annual Leave lets this employee file depends on
  // entitlement rules this test is not about, so a refusal skips the row rather than failing the sweep.
  await requestLeave(a, {
    employmentId: e.employmentId,
    leaveTypeId: base.annualLeaveTypeId,
    startDate: `${year - 1}-12-01`,
    endDate: `${year - 1}-12-01`,
    today: `${year - 1}-11-20`,
  } as never).catch(() => undefined);
  const rows = await movementHistory(a, e.employmentId);
  const secondment = rows.find((r) => r.kind === 'secondment');
  expect(secondment, 'the fixture recorded a secondment').toBeDefined();
  return { ...e, secondmentId: secondment!.id };
}

async function html(employmentId: string, sp: Record<string, string>): Promise<string> {
  const tree = await EmployeePage({ params: Promise.resolve({ employmentId }), searchParams: Promise.resolve(sp) } as never);
  const stream = await renderToReadableStream(tree, { onError: (err) => void console.error(err) });
  await stream.allReady;
  return await new Response(stream).text();
}

/**
 * Every string a reader SEES or HEARS on a rendered document: each text node (script and style bodies are
 * not text the reader sees), plus the value of a box that draws its value as text (a read-only
 * `<input>` that is not a date or hidden input), plus `title` (a tooltip), `aria-label` and `placeholder`.
 * NOT swept: a date input's value, `dateTime=`, `href`, `name` — machine contracts that are ISO by design.
 */
/** Every native date box that is NOT inside the r422 DateField — i.e. one that still draws the browser's
 *  own locale format. Named by its `name` (or its outerHTML when it has none). */
function bareDateInputs(markup: string): string[] {
  const doc = new JSDOM(markup).window.document;
  return [...doc.querySelectorAll('input[type="date"]')]
    .filter((el) => !el.closest('[data-date-field]'))
    .map((el) => el.getAttribute('name') ?? el.outerHTML);
}

function seenStrings(markup: string): string[] {
  const dom = new JSDOM(markup);
  const doc = dom.window.document;
  doc.querySelectorAll('script, style, template').forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue?.trim();
    if (v) out.push(v);
  }
  doc.querySelectorAll('input').forEach((el) => {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (['date', 'hidden', 'month', 'datetime-local', 'checkbox', 'radio', 'file'].includes(type)) return;
    const v = el.getAttribute('value');
    if (v) out.push(`[value] ${v}`);
  });
  doc.querySelectorAll('[title], [aria-label], [placeholder]').forEach((el) => {
    for (const a of ['title', 'aria-label', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v) out.push(`[${a}] ${v}`);
    }
  });
  return out;
}

describe('r422 — the employee profile draws every date as DD-MMM-YYYY', () => {
  it('no text on any tab or opened view carries a raw yyyy-mm-dd, and the sweep saw the fixture’s dates', async () => {
    const e = await seedEmployee();
    session.s = await entitledCtx(base);
    session.scopeIds = [base.companyId];

    // Every tab's panel stays MOUNTED (components/personnel-tabs.tsx), so one render of each view draws all
    // eleven tabs; the views are the ones a query string opens inside the Movement tab.
    const views: Record<string, string>[] = [
      { tab: 'profile' },
      { tab: 'careerMovement', movement: 'hired' },
      { tab: 'careerMovement', movement: e.secondmentId },
      { tab: 'careerMovement', newEvent: '1' },
      { tab: 'careerMovement', editMovement: e.secondmentId },
      { tab: 'careerMovement', correctHire: '1' },
      { tab: 'careerMovement', showCorrected: '1' },
    ];
    const seen: string[] = [];
    const raw: string[] = [];
    const bare: string[] = [];
    let dateFields = 0;
    for (const sp of views) {
      const markup = await html(e.employmentId, sp);
      const strings = seenStrings(markup);
      raw.push(...strings.filter((t) => ISO.test(t)).map((t) => `${JSON.stringify(sp)} → ${t}`));
      seen.push(...strings);
      bare.push(...bareDateInputs(markup).map((n) => `${JSON.stringify(sp)} → ${n}`));
      dateFields += (markup.match(/data-date-field/g) ?? []).length;
    }
    expect(raw, 'raw ISO dates drawn as text').toEqual([]);
    // Editable dates: every date box on the profile is the DD-MMM-YYYY DateField, and there ARE some.
    expect(bare, 'native date inputs drawn outside DateField').toEqual([]);
    expect(dateFields, 'the sweep saw DateFields').toBeGreaterThanOrEqual(10);

    const dmy = seen.filter((t) => DMY.test(t));
    expect(dmy.length, 'the sweep saw formatted dates').toBeGreaterThanOrEqual(20);
    const all = seen.join('\n');
    for (const iso of [
      hiredOn,
      childDob,
      graduation,
      cp38From,
      confirmedOn,
      secondFrom,
      secondTo,
      passportIssued,
      passportExpires,
      payItemFrom,
      delegationFrom,
      superiorFrom,
      pendingOn,
    ]) {
      expect(all, `${iso} drawn as ${formatDmy(iso)}`).toContain(formatDmy(iso));
    }
  });
});
