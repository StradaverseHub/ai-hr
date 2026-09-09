/**
 * f1bbc572 (round 2) — A GLOBAL LABEL YOU MAY SEE IS NOT NECESSARILY ONE YOU MAY EDIT.
 *
 * f1bbc572 made "Criteria = Global" mean what it says: the label is listed for every company, whichever
 * company happened to create it. That handed a COMPANY-SCOPED hr_admin rows whose ORIGIN company they do
 * not administer — and the grid drew them as ordinary editable inputs. The database does not agree:
 * `CREATE POLICY tenant_isolation ON department … WITH CHECK (… app.is_admin_for(company_id))`
 * (0016_company_scoped_authz.sql:101-103) refuses that UPDATE, and Save is ATOMIC, so one such row
 * silently discarded every other row the admin had edited in the same Save.
 *
 * So the honest shape is READ-ONLY, not hidden — hiding it is the defect the round fixed. This suite
 * pins that shape:
 *   • a row outside `writableCompanyIds` renders read-only inputs, and typing changes nothing;
 *   • its Criteria cell states the scope instead of offering the popover (setGlobal / assign are writes);
 *   • Duplicate is withheld, because the copy is INSERTED under the source row's own company and RLS
 *     would refuse that insert exactly as it refuses the update;
 *   • a refusal that does reach the client (a stale page, a grant revoked mid-session) is rendered as a
 *     translated sentence — never the driver's `Failed query: update "department" set …`.
 *
 * WHY A RENDER TEST. Every claim above is about what the admin can DO on screen: a read-only input, a
 * disabled button, a banner's words. None is visible to a source assertion, and none is a statement
 * about a pure function.
 *
 * `onError` THROWS on a missing translation, so the last case proves the new keys resolve in all six
 * locales rather than painting MISSING_MESSAGE on a screen that returns 200.
 *
 * Scope, inherited from every dom test here: jsdom applies no CSS and computes no layout. What this
 * proves is rendering and interaction logic, not pixels.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

/** Company A owns the Global row; the admin administers company B only — the production shape (the
 *  origin company is not even in the admin's switcher scope, which is why `companies` holds only B). */
const OWN = row({ id: 'own', companyId: 'co-b', name: 'B Own Department' });
const FOREIGN_GLOBAL = row({ id: 'glob', companyId: 'co-a', name: 'A Global Department', isGlobal: true });

const okSave = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] }));

function renderGrid(
  save: GridActionsSave = okSave,
  locale = 'en',
  messages: Record<string, unknown> = en,
) {
  return wrap(
    <SystemLabelsGrid
      data={{ department: [OWN, FOREIGN_GLOBAL], position: [], cost_center: [], business_unit: [] }}
      companies={[{ id: 'co-b', name: 'B Sdn Bhd', sharedSystemLabels: true }]}
      writableCompanyIds={['co-b']}
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

type GridActionsSave = React.ComponentProps<typeof SystemLabelsGrid>['actions']['save'];

const rows = (c: HTMLElement) => [...c.querySelectorAll('tbody tr')] as HTMLElement[];
const codeInput = (tr: HTMLElement) => tr.querySelector('[data-cell^="name:"]') as HTMLInputElement;

describe('f1bbc572 — a label whose company this admin does not administer is read-only', () => {
  it('renders both rows, and only the foreign one read-only', () => {
    const { container } = renderGrid();
    const [own, foreign] = rows(container);
    // Visible: hiding it is the defect this round FIXED.
    expect(codeInput(foreign).value).toBe('A Global Department');
    expect(codeInput(foreign).readOnly).toBe(true);
    expect(codeInput(own).readOnly).toBe(false);
    // Every text cell of the row, not just the first.
    for (const cell of foreign.querySelectorAll('input[data-cell]')) {
      expect((cell as HTMLInputElement).readOnly).toBe(true);
    }
  });

  it('typing into a read-only cell changes nothing and leaves Save disabled', async () => {
    const user = userEvent.setup();
    const { container } = renderGrid();
    const foreign = codeInput(rows(container)[1]);
    await user.click(foreign);
    await user.keyboard('EDITED');
    expect(foreign.value).toBe('A Global Department');
    // The atomic-Save hazard in one assertion: nothing became dirty, so there is nothing to submit.
    expect(screen.getByRole('button', { name: en.admin.systemLabels.saveAll })).toBeDisabled();
  });

  it('withholds Criteria and Duplicate on the read-only row, and offers both on the writable one', () => {
    const { container } = renderGrid();
    const [own, foreign] = rows(container);
    // Writable: Criteria pill + Duplicate + Archive. Read-only: Duplicate + Archive, both disabled, and
    // the Criteria cell is a plain statement of scope rather than the popover trigger.
    expect(within(own).getAllByRole('button')).toHaveLength(3);
    const foreignButtons = within(foreign).getAllByRole('button');
    expect(foreignButtons).toHaveLength(2);
    for (const b of foreignButtons) expect(b).toBeDisabled();
    expect(within(foreign).getByText(en.admin.systemLabels.scopeGlobal).tagName).toBe('SPAN');
    expect(within(own).getByTitle(en.admin.systemLabels.duplicateRow)).toBeEnabled();
  });

  it('says WHY in the reader’s language when the server refuses, and never shows the SQL', async () => {
    const user = userEvent.setup();
    const refuse: GridActionsSave = vi.fn(async () => ({
      ok: false as const,
      // Exactly what bulkSaveLabels now returns for an RLS refusal: a token plus a diagnostic sentence.
      rowErrors: [{ key: 'glob', code: 'notAdminForCompany', message: 'This label belongs to a company you do not administer.' }],
      // …and what the action would once have passed straight through instead.
      message: 'Failed query: update "department" set "name" = $1 params: RenamedByB',
    }));
    const { container } = renderGrid(refuse);
    // Dirty the WRITABLE row so there is a Save to make.
    await user.type(codeInput(rows(container)[0]), 'X');
    await user.click(screen.getByRole('button', { name: en.admin.systemLabels.saveAll }));

    expect(await screen.findByText(en.admin.systemLabels.notAdminForCompany)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Failed query/);
    expect(container.textContent).not.toMatch(/update "department"/);
  });

  it.each([
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ] as const)('%s has real words for the read-only tooltip and the refusal', (locale, messages) => {
    const { container } = renderGrid(okSave, locale, messages as unknown as Record<string, unknown>);
    const tip = codeInput(rows(container)[1]).title;
    const m = messages as unknown as { admin: { systemLabels: Record<string, string> } };
    expect(tip).toBe(m.admin.systemLabels.readOnlyRow);
    // A real sentence, not the key echoed back and not English left in place.
    expect(tip.length).toBeGreaterThan(10);
    expect(tip).not.toBe('readOnlyRow');
    if (locale !== 'en') expect(tip).not.toBe(en.admin.systemLabels.readOnlyRow);
    expect(m.admin.systemLabels.notAdminForCompany.length).toBeGreaterThan(10);
    expect(m.admin.systemLabels.unexpectedError.length).toBeGreaterThan(10);
  });
});
