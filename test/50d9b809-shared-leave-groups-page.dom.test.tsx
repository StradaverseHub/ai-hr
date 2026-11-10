/**
 * 50d9b809 — SHARED LEAVE GROUPS GET THEIR OWN PAGE, RENDERED.
 *
 * The group editor was a Radix pop-up behind a "Shared leave groups" button on the Entitlements screen. The
 * reporter found it hard to find and cramped, and asked for a Leave Settings card that opens a page of its
 * own where the list, Create, Edit and Delete work on the page itself. The editor component is the same one
 * (`LeaveSharedGroupConfig`) with its Dialog shell removed, so this file RENDERS it and looks:
 *
 *  §A the list is on the page at first paint — every group's name, the leave types it combines, the
 *     shared limit, the per-application cap ("No limit" when blank) and where employees see it — and there
 *     is NO dialog and no pop-up trigger button.
 *  §B Create is an inline form on the page: the same five fields, a new group starting Hidden.
 *  §C Edit opens THAT group's form in place, pre-filled from the row, one at a time; Cancel closes it. Still
 *     no dialog — the only dialog left is Delete's existing confirmation, which opens on click.
 *  §D Delete keeps its confirmation and posts the group id from its own form.
 *  §E the composition the component cannot see: the new page mounts the editor with the three unchanged
 *     actions, and the Entitlements screen no longer renders it.
 *  §F all six locales render the page's own strings rather than message keys.
 *
 * Presentation only: no action, validation, permission or calculation changed (core/leave-shared-group.ts
 * is untouched), so nothing here needs a database.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveSharedGroupConfig, type SharedGroup } from '../components/leave-shared-group-config';

const CATALOGUES = { en, ms, ta, th, vi: vi_, zh } as const;
type Locale = keyof typeof CATALOGUES;
const root = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Fictional leave types — names are examples only. */
const LEAVE_TYPES = [
  { id: 'lt-comp', name: 'Compassionate Leave' },
  { id: 'lt-marr', name: 'Marriage Leave' },
  { id: 'lt-child', name: 'Child Sick Leave' },
  { id: 'lt-parent', name: 'Parent Care Leave' },
];
const GROUPS: SharedGroup[] = [
  {
    id: 'g-special',
    name: 'Special Leave',
    totalLimitDays: 10,
    maxDaysPerApplication: 3,
    essPlacement: 'primary',
    leaveTypeIds: ['lt-comp', 'lt-marr'],
  },
  {
    id: 'g-family',
    name: 'Family Care',
    totalLimitDays: 7.5,
    maxDaysPerApplication: null,
    essPlacement: 'hidden',
    leaveTypeIds: ['lt-child', 'lt-parent'],
  },
];

function mount(locale: Locale = 'en', groups: SharedGroup[] = GROUPS) {
  const actions = { create: vi.fn(), update: vi.fn(), remove: vi.fn() };
  const view = render(
    <NextIntlClientProvider locale={locale} timeZone="Asia/Kuala_Lumpur" messages={CATALOGUES[locale] as never}>
      <LeaveSharedGroupConfig groups={groups} leaveTypes={LEAVE_TYPES} actions={actions} />
    </NextIntlClientProvider>,
  );
  return { ...view, actions };
}

const g = en.admin.leave.sharedGroup;
const rows = () => screen.getAllByTestId('shared-group-row');
const rowFor = (name: string) => rows().find((r) => within(r).queryByText(name) !== null)!;

describe('50d9b809 §A — the list is on the page, and there is no pop-up', () => {
  it('renders every group with its leave types, limits and placement, and no dialog', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The old trigger ("Shared leave groups" button with a count badge) is gone; the list is the page.
    expect(screen.queryByRole('button', { name: /shared leave groups/i })).toBeNull();

    const list = screen.getByTestId('shared-group-list');
    expect(within(list).getByText(g.listTitle)).toBeInTheDocument();
    expect(rows()).toHaveLength(2);

    const special = rowFor('Special Leave');
    expect(within(special).getByText('Compassionate Leave, Marriage Leave')).toBeInTheDocument();
    expect(within(special).getByText('10')).toBeInTheDocument();
    expect(within(special).getByText('3')).toBeInTheDocument();
    expect(within(special).getByText(g.placementOption.primary)).toBeInTheDocument();

    const family = rowFor('Family Care');
    expect(within(family).getByText('Child Sick Leave, Parent Care Leave')).toBeInTheDocument();
    expect(within(family).getByText('7.5')).toBeInTheDocument();
    // A blank cap is the real answer "no cap", shown in words rather than as an empty cell or a 0.
    expect(within(family).getByText(g.maxPerApplicationBlank)).toBeInTheDocument();
    expect(within(family).getByText(g.placementOption.hidden)).toBeInTheDocument();
  });

  it('says so when there are no groups yet, and still offers Create', () => {
    mount('en', []);
    expect(screen.getByText(g.empty)).toBeInTheDocument();
    expect(screen.queryAllByTestId('shared-group-row')).toHaveLength(0);
    expect(within(screen.getByTestId('shared-group-create')).getByRole('button', { name: g.create })).toBeInTheDocument();
  });
});

describe('50d9b809 §B — Create is an inline form with the same fields', () => {
  it('carries name, shared limit, cap, members and placement, starting Hidden', () => {
    mount();
    const create = screen.getByTestId('shared-group-create');
    expect(within(create).getByText(g.createTitle)).toBeInTheDocument();
    const form = create.querySelector('form')!;
    expect(form).not.toBeNull();
    expect(form.querySelector('input[name="name"]')).toHaveAttribute('placeholder', g.namePlaceholder);
    expect(form.querySelector('input[name="totalLimitDays"]')).toBeRequired();
    // Blank stays blank: the action maps '' to null ("no cap"), never to a zero-day cap.
    expect(form.querySelector('input[name="maxDaysPerApplication"]')).toHaveValue(null);
    expect(form.querySelector('select[name="essPlacement"]')).toHaveValue('hidden');
    expect(within(form).getByRole('button', { name: g.create })).toHaveAttribute('type', 'submit');
    // Exactly one create form on the page.
    expect(document.querySelectorAll('[data-testid="shared-group-create"] form')).toHaveLength(1);
  });
});

describe('50d9b809 §C — Edit opens that group\'s form in place', () => {
  it('opens one pre-filled form under its row, swaps on another Edit, and Cancel closes it', async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole('form', { name: `Edit · Family Care` })).toBeNull();

    const family = rowFor('Family Care');
    await user.click(within(family).getByRole('button', { name: g.edit }));

    const form = screen.getByRole('form', { name: 'Edit · Family Care' });
    // In place: inside the group's own row, not in a portal and not in a dialog.
    expect(family.contains(form)).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(form).getByText('Edit · Family Care')).toBeInTheDocument();
    expect(form.querySelector('input[name="id"]')).toHaveValue('g-family');
    expect(form.querySelector('input[name="name"]')).toHaveValue('Family Care');
    expect(form.querySelector('input[name="totalLimitDays"]')).toHaveValue(7.5);
    // The cap input is ALWAYS posted (it is absolute-set): blank here means "no cap", kept as blank.
    expect(form.querySelector('input[name="maxDaysPerApplication"]')).toHaveValue(null);
    expect(form.querySelector('select[name="essPlacement"]')).toHaveValue('hidden');
    const members = [...form.querySelectorAll('input[type="hidden"][name="leaveTypeIds"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(members).toEqual(['lt-child', 'lt-parent']);
    expect(within(form).getByRole('button', { name: g.save })).toHaveAttribute('type', 'submit');
    // The row's toggle now reads Close and says it is expanded.
    expect(within(family).getByRole('button', { name: g.close })).toHaveAttribute('aria-expanded', 'true');

    // One open at a time: editing another group closes this one.
    await user.click(within(rowFor('Special Leave')).getByRole('button', { name: g.edit }));
    expect(screen.queryByRole('form', { name: 'Edit · Family Care' })).toBeNull();
    const special = screen.getByRole('form', { name: 'Edit · Special Leave' });
    expect(special.querySelector('input[name="maxDaysPerApplication"]')).toHaveValue(3);
    expect(special.querySelector('select[name="essPlacement"]')).toHaveValue('primary');

    await user.click(within(special).getByRole('button', { name: g.cancel }));
    expect(screen.queryByRole('form', { name: 'Edit · Special Leave' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('50d9b809 §D — Delete keeps its confirmation', () => {
  it('posts the group id from its own form and asks before deleting', async () => {
    const user = userEvent.setup();
    mount();
    const family = rowFor('Family Care');
    const del = within(family).getByRole('button', { name: g.delete });
    const form = del.closest('form')!;
    expect(form.querySelector('input[name="id"]')).toHaveValue('g-family');
    await user.click(del);
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(g.deleteConfirmTitle)).toBeInTheDocument();
    expect(within(confirm).getByText('Family Care')).toBeInTheDocument();
    expect(within(confirm).getByText(g.deleteConfirmDescription)).toBeInTheDocument();
  });
});

describe('50d9b809 §E — the page mounts the editor; Entitlements no longer does', () => {
  it('the Shared Leave Groups page renders the editor with the three unchanged actions', () => {
    const page = stripComments(read('app/admin/leave-config/shared-groups/page.tsx'));
    expect(page).toContain('await requireAdmin()');
    expect(page).toContain("leaveConfigPageHeader('sharedGroups')");
    expect(page).toContain('<LeaveConfigMap current="sharedGroups" />');
    expect(page).toContain('<ErrorBanner message={error} />');
    expect(page).toContain('<LeaveSharedGroupConfig');
    for (const action of ['createLeaveSharedGroupAction', 'updateLeaveSharedGroupAction', 'deleteLeaveSharedGroupAction'])
      expect(page).toContain(action);
    expect(page).toContain('listLeaveSharedGroups(s)');
  });

  it('the Entitlements screen no longer renders the editor, its trigger or its data', () => {
    const types = stripComments(read('app/admin/leave-config/types/page.tsx'));
    expect(types).not.toContain('LeaveSharedGroupConfig');
    expect(types).not.toContain('listLeaveSharedGroups');
    expect(types).not.toContain('SharedGroupAction');
  });

  it('the editor has no Dialog shell left', () => {
    const editor = read('components/leave-shared-group-config.tsx');
    expect(editor).not.toContain("from '@radix-ui/react-dialog'");
    expect(editor).not.toMatch(/<Dialog\./);
  });

  it('every save and refusal of the three actions returns to the new page', () => {
    const actions = read('app/admin/actions.ts');
    const block = stripComments(actions.slice(actions.indexOf('async function sharedGroupFailure('), actions.indexOf('export async function deleteLeaveSharedGroupAction')));
    const del = stripComments(actions.slice(actions.indexOf('export async function deleteLeaveSharedGroupAction')));
    const deleteBody = del.slice(0, del.indexOf('\n}\n') + 3);
    const all = block + deleteBody;
    expect(all).not.toContain('ENTITLEMENTS');
    expect(all.match(/ok\(SHARED_GROUPS\)/g) ?? []).toHaveLength(3);
    expect(all.match(/fail\(SHARED_GROUPS,/g) ?? []).toHaveLength(4);
    expect(read('app/admin/_redirects.ts')).toContain("export const SHARED_GROUPS = '/admin/leave-config/shared-groups';");
  });
});

describe('50d9b809 §F — every locale renders the page\'s own words', () => {
  it.each(Object.keys(CATALOGUES) as Locale[])('%s', async (locale) => {
    const user = userEvent.setup();
    mount(locale);
    const sg = CATALOGUES[locale].admin.leave.sharedGroup;
    expect(screen.getByText(sg.listTitle)).toBeInTheDocument();
    expect(screen.getByText(sg.createTitle)).toBeInTheDocument();
    await user.click(within(rowFor('Family Care')).getByRole('button', { name: sg.edit }));
    expect(screen.getByRole('form', { name: sg.editTitle.replace('{name}', 'Family Care') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: sg.cancel })).toBeInTheDocument();
    // No raw message key anywhere on the screen.
    expect(document.body.textContent).not.toMatch(/admin\.leave\.sharedGroup|sharedGroup\.\w+/);
  });
});
