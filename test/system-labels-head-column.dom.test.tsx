/**
 * r285 (0d40ab99) — THE HEAD (LEAVE APPROVER) CONTROL EXISTS AGAIN, AND IT CHANGES ROUTING.
 *
 * `department_head` and `business_unit_head` are two of the seven approver kinds a chain may name, and
 * between 797e3523 and this round neither could ever fire. That commit removed the Head column from
 * Settings → System Labels and left `headEmploymentId` round-tripping silently through Save; after it no
 * `name="headEmploymentId"` control existed anywhere in the repo, so nothing could set a head. A head
 * step whose head is unset is DROPPED at submission (core/leave.ts generateApprovalSteps), so on the live
 * tenant — 0 of 25 departments and 0 of 7 business units with a head — every such step was silently
 * skipped. The screen offered a routing choice the product then ignored.
 *
 * WHAT THIS FILE PINS, and why each claim needs a RENDER rather than a source assertion:
 *   • a real `<select name="headEmploymentId">` renders, on the two kinds that head somebody and on
 *     NEITHER of the two that do not;
 *   • its blank option is a VALUE, not a placeholder: choosing it sends `null`, which the service reads
 *     as an explicit clear. A form field that is always submitted cannot be read by presence, so the
 *     difference between "cleared" and "untouched" has to be visible in the payload, and it is asserted
 *     there;
 *   • a row that already HAS a head never draws blank — not even when the option list is missing that
 *     employment. Blank on this column states "no head", and stating that about a department that has
 *     one is the same defect wearing a new coat;
 *   • a text-only edit re-sends the loaded head unchanged, so renaming a department cannot silently
 *     unroute its approvals;
 *   • on a row whose company this admin does not administer the head is STATED, not offered — the write
 *     is RLS-refused and Save is atomic (f1bbc572).
 *
 * The payload this file captures is the SAME object `saveLabelsGridAction` hands to `bulkSaveLabels`
 * untouched; test/system-labels-head-routing.test.ts picks it up from there and proves the department
 * head step then resolves to the chosen person. The two halves are typed against one another through
 * `GridActions` so the contract cannot drift in silence.
 *
 * `onError` THROWS on a missing translation, so the six-locale case proves the header and the None
 * option resolve to real words rather than painting MISSING_MESSAGE on a screen that returns 200.
 *
 * Scope, inherited from every dom test here: jsdom applies no CSS and computes no layout. What this
 * proves is rendering and interaction logic, not pixels.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { SystemLabelsGrid, type GridRecord } from '../components/system-labels-grid';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  replace.mockClear();
  window.localStorage.clear();
});

type GridProps = React.ComponentProps<typeof SystemLabelsGrid>;
type GridSave = GridProps['actions']['save'];
/** The exact payload shape the grid submits — the one the node half of this proof feeds the service. */
type GridSavePayload = Parameters<GridSave>[1];

function wrap(node: ReactNode, locale = 'en', messages: Record<string, unknown> = en) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const row = (over: Partial<GridRecord> & { id: string; companyId: string }): GridRecord => ({
  code: '',
  name: '',
  title: '',
  jobFamily: '',
  label: '',
  businessUnitId: null,
  headEmploymentId: null,
  description: '',
  isGlobal: false,
  archived: false,
  inUse: false,
  assignedCompanyIds: [over.companyId],
  createdAt: null,
  lastUpdatedAt: null,
  lastUpdatedBy: null,
  ...over,
});

const CO = 'co-a';
const HEADS = {
  [CO]: [
    { id: 'emp-lina', label: 'Lina Tan (E001)' },
    { id: 'emp-ravi', label: 'Ravi Kumar (E002)' },
  ],
};

const FINANCE = row({ id: 'dep-fin', companyId: CO, name: 'Finance' });
const OPS = row({ id: 'dep-ops', companyId: CO, name: 'Operations', headEmploymentId: 'emp-ravi' });
const BU_NORTH = row({ id: 'bu-n', companyId: CO, code: 'BU-N', name: 'North' });
const POS_CLERK = row({ id: 'pos-1', companyId: CO, title: 'Clerk' });
const CC_ONE = row({ id: 'cc-1', companyId: CO, code: 'CC1', name: 'Head Office' });

const okSave: GridSave = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] }));

function renderGrid(
  opts: {
    save?: GridSave;
    departments?: GridRecord[];
    headByCompany?: Record<string, { id: string; label: string }[]>;
    writableCompanyIds?: string[];
    companies?: { id: string; name: string; sharedSystemLabels: boolean }[];
    locale?: string;
    messages?: Record<string, unknown>;
  } = {},
) {
  const {
    save = okSave,
    departments = [FINANCE, OPS],
    headByCompany = HEADS,
    writableCompanyIds = [CO],
    companies = [{ id: CO, name: 'Acme Sdn Bhd', sharedSystemLabels: true }],
    locale = 'en',
    messages = en,
  } = opts;
  return wrap(
    <SystemLabelsGrid
      data={{ department: departments, position: [POS_CLERK], cost_center: [CC_ONE], business_unit: [BU_NORTH] }}
      companies={companies}
      writableCompanyIds={writableCompanyIds}
      headByCompany={headByCompany}
      isGroupAdmin={false}
      actions={{
        save,
        setGlobal: vi.fn(async () => ({ ok: true as const })),
        assign: vi.fn(async () => ({ ok: true as const })),
        unassign: vi.fn(async () => ({ ok: true as const })),
        copyToCompanies: vi.fn(async () => ({ ok: true as const })),
        setCompanyShared: vi.fn(async () => ({ ok: true as const })),
      }}
    />,
    locale,
    messages,
  );
}

const heads = (c: HTMLElement) => [...c.querySelectorAll('select[name="headEmploymentId"]')] as HTMLSelectElement[];
const nameCell = (c: HTMLElement, i: number) =>
  c.querySelectorAll('[data-cell^="name:"]')[i] as HTMLInputElement;
const saveBtn = () => screen.getByRole('button', { name: en.admin.systemLabels.saveAll });
const lastPayload = (save: GridSave): GridSavePayload =>
  (save as unknown as { mock: { calls: [string, GridSavePayload][] } }).mock.calls.at(-1)![1];

describe('r285 — the Head (leave approver) column is back on System Labels', () => {
  it('renders a real name="headEmploymentId" select per department row, with a genuine blank option', () => {
    const { container } = renderGrid();
    const selects = heads(container);
    expect(selects).toHaveLength(2);

    // The blank option is the FIRST option and carries the empty value — "no head", not a prompt that
    // silently stands for something else.
    const blank = selects[0].options[0];
    expect(blank.value).toBe('');
    expect(blank.textContent).toBe(en.admin.organization.headNone);
    // …and the company's employments follow it, by name.
    expect([...selects[0].options].map((o) => o.value)).toEqual(['', 'emp-lina', 'emp-ravi']);
    // The header says what the column is FOR, in the same words the Approval Workflow footnote uses.
    expect(screen.getByRole('columnheader', { name: en.admin.organization.fieldHead })).toBeInTheDocument();
  });

  it('offers the column on Business Units too, and on neither Positions nor Cost Centres', async () => {
    const user = userEvent.setup();
    const { container } = renderGrid();
    const cat = en.admin.systemLabels.category;

    await user.click(screen.getByRole('button', { name: new RegExp(`^${cat.business_unit}`) }));
    expect(heads(container)).toHaveLength(1);

    // A position heads nobody, and neither does a cost centre — offering the column there would invent
    // an approval target the resolver has no branch for.
    await user.click(screen.getByRole('button', { name: new RegExp(`^${cat.position}`) }));
    expect(heads(container)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: new RegExp(`^${cat.cost_center}`) }));
    expect(heads(container)).toHaveLength(0);
  });

  it('sends the chosen employment id on Save — the payload the service turns into routing', async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] })) as GridSave;
    const { container } = renderGrid({ save });

    await user.selectOptions(heads(container)[0], 'emp-lina');
    expect(saveBtn()).toBeEnabled();
    await user.click(saveBtn());

    const payload = lastPayload(save);
    expect(payload.updates).toHaveLength(1);
    expect(payload.updates[0]).toMatchObject({ id: 'dep-fin', headEmploymentId: 'emp-lina' });
  });

  it('sends null when None is chosen — an explicit CLEAR, not an untouched field', async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] })) as GridSave;
    // Operations already has a head; picking None must remove it rather than leave it in place.
    const { container } = renderGrid({ save });

    await user.selectOptions(heads(container)[1], '');
    await user.click(saveBtn());

    const cleared = lastPayload(save).updates.find((u) => u.id === 'dep-ops');
    expect(cleared).toBeDefined();
    // null, NOT undefined: `undefined` is the tri-state's "leave the column alone" and would make the
    // None option a no-op that looks like it worked.
    expect(cleared!.headEmploymentId).toBeNull();
  });

  it('a row that already has a head shows that head, and never blank', () => {
    const { container } = renderGrid();
    expect(heads(container)[0].value).toBe(''); // Finance genuinely has none
    expect(heads(container)[1].value).toBe('emp-ravi'); // Operations does
  });

  it('shows a stored head that is missing from the option list rather than drawing blank', () => {
    // The hazard: a `<select>` whose value matches no option renders EMPTY, which on this column reads
    // as "this department has no head" about a department that has one.
    const { container } = renderGrid({ headByCompany: { [CO]: [{ id: 'emp-lina', label: 'Lina Tan (E001)' }] } });
    const ops = heads(container)[1];
    expect(ops.value).toBe('emp-ravi');
    expect([...ops.options].map((o) => o.value)).toContain('emp-ravi');
  });

  it('a text-only edit re-sends the loaded head unchanged — renaming a unit cannot unroute it', async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] })) as GridSave;
    const { container } = renderGrid({ save });

    await user.type(nameCell(container, 1), ' & Logistics');
    await user.click(saveBtn());

    const u = lastPayload(save).updates.find((x) => x.id === 'dep-ops')!;
    expect(u.name).toBe('Operations & Logistics');
    expect(u.headEmploymentId).toBe('emp-ravi');
  });

  it('states the head instead of offering it on a row whose company this admin does not administer', () => {
    const { container } = renderGrid({ writableCompanyIds: [] });
    // No select at all — the UPDATE would be RLS-refused and Save is atomic, so every other edited row
    // would go down with it.
    expect(heads(container)).toHaveLength(0);
    // …but the head is still SHOWN, because this is a row the admin is entitled to read.
    expect(screen.getByText('Ravi Kumar (E002)')).toBeInTheDocument();
    expect(screen.getAllByText(en.admin.organization.headNone).length).toBeGreaterThan(0);
  });

  it.each([
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ] as const)('%s has real words for the Head header and the None option', (locale, messages) => {
    const { container } = renderGrid({ locale, messages: messages as unknown as Record<string, unknown> });
    const m = messages as unknown as { admin: { organization: Record<string, string> } };
    expect(heads(container)[0].options[0].textContent).toBe(m.admin.organization.headNone);
    expect(screen.getByRole('columnheader', { name: m.admin.organization.fieldHead })).toBeInTheDocument();
    // A real phrase, not the key echoed back and not English left in place.
    expect(m.admin.organization.fieldHead.length).toBeGreaterThan(3);
    expect(m.admin.organization.fieldHead).not.toBe('fieldHead');
    if (locale !== 'en') expect(m.admin.organization.fieldHead).not.toBe(en.admin.organization.fieldHead);
  });
});
