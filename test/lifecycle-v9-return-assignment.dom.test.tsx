/** d1e26f81 — offboarding Return and revoke laid out like onboarding Equipment and access. Fictional data only. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import messages from '../messages/en.json';
import { OffboardingReturns } from '../app/lifecycle/v9/offboarding-returns';
import { PendingReturns } from '../app/lifecycle/v9/pending-returns';
import { readV9Case } from '../app/lifecycle/v9/actions';
import { fictionalV9Case } from './fixtures/lifecycle-v9/case';
import type { Config, Item } from '../lib/lifecycle-v9-model';
vi.mock('../app/lifecycle/v9/actions', () => ({ readV9Case: vi.fn(), commandV9: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], peopleOpsGroup: null, bpRules: [], groups: [{ id: 'group-tech', name: 'Group Tech', members: ['alex', 'fictional-employee'], limit: 8 }, { id: 'facility', name: 'Facility', members: ['fay'], limit: 4 }] } as unknown as Config;
const users = [{ id: 'alex', name: 'Alex Tan' }, { id: 'fay', name: 'Fay Lim' }, { id: 'fictional-employee', name: 'Fictional Employee' }];
const item = (patch: Partial<Item>): Item => ({ id: 'i', name: 'Item', kind: 'system', sourceId: null, group: 'group-tech', assignee: null, dueOn: '2026-11-30', status: 'todo', reason: '', ...patch });
const items: Item[] = [
  item({ id: 'm365', name: 'Microsoft 365', assignee: 'alex', method: 'rr', dueDay: 0, providedBy: { group: 'group-tech', userId: 'alex', at: '2026-10-11T03:00:00Z' }, nativeSource: { caseId: 'onb', requestId: 'r', requestNumber: 'IT-REQ-0006', itemId: 'x' } }),
  item({ id: 'card', name: 'Access Card', kind: 'device', group: 'facility', method: 'rr', dueDay: -1, dueOn: '2026-11-29', cardStep: 'collect', assignmentFailure: 'Everyone available in Facility is at their limit of 4 open tasks.' }),
  item({ id: 'fixed', name: 'Kingdee', method: 'rr', dueDay: null, dueOn: '2026-11-20', assignee: 'alex' }),
  item({ id: 'done', name: 'Laptop', kind: 'device', status: 'done', assignee: 'alex', method: 'rr', dueDay: -1, dueOn: '2026-11-29' }),
];
function view(command = vi.fn().mockResolvedValue({ ok: true }), locale = 'en', state: 'submitted' | 'pending' = 'submitted') {
  const c = fictionalV9Case({ state, items: state === 'pending' ? [] : structuredClone(items) });
  render(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))}><OffboardingReturns c={c} config={config} users={users} busy={false} command={command} note={() => null}/></NextIntlClientProvider>);
  return { c, command };
}

describe('submitted Return and revoke', () => {
  it('shows the onboarding header, summary lines, owner caption, Day offsets, Provided by and the visible reason', () => {
    view();
    const section = screen.getByRole('region', { name: 'Return and revoke' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Return and revoke' })).toBeInTheDocument();
    expect(section).toHaveTextContent('4 items');
    const table = within(screen.getByRole('table', { name: 'Return and revoke' }));
    const m365 = table.getByText('Microsoft 365').closest('tr')!, card = table.getByText('Access Card').closest('tr')!, fixed = table.getByText('Kingdee').closest('tr')!;
    expect(m365).toHaveTextContent('Group Tech · Round robin · due Day 0');
    expect(m365).toHaveTextContent('30/11/2026 (Day 0)');
    expect(within(m365).getAllByRole('cell')[2]).toHaveTextContent('Group TechAlex Tan · 11/10/2026');
    expect(within(m365).getByRole('combobox', { name: 'Assignee for Microsoft 365' })).toHaveValue('alex');
    // The leaver is never offered as the owner of their own return work.
    expect(within(m365).queryByRole('option', { name: 'Fictional Employee' })).toBeNull();
    expect(m365).toHaveTextContent('Group Tech · Round robin');
    expect(card).toHaveTextContent('Collect the card');
    expect(card).toHaveTextContent('29/11/2026 (Day -1)');
    expect(within(card).getByRole('note')).toHaveTextContent('Everyone available in Facility is at their limit of 4 open tasks.');
    expect(within(card).getByRole('note')).toHaveClass('lifecycle-case-task-warning');
    expect(fixed).toHaveTextContent('Group Tech · Round robin · due 20/11/2026');
    expect(within(fixed).getAllByRole('cell')[4]).toHaveTextContent(/^20\/11\/2026$/);
    expect(within(fixed).getAllByRole('cell')[2]).toHaveTextContent('—');
  });

  it('applies "Set for all items" to the items not yet done, with the onboarding panel', async () => {
    const { command } = view();
    fireEvent.click(screen.getByRole('button', { name: 'Set for all items' }));
    expect(screen.getByText('3 items not yet done')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Team for all items' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Assignment for all items' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Due by Day for all items' })).toHaveValue('');
    expect(screen.getByText("Changing the team reassigns round-robin items to someone in the new team. Items already done aren't changed.")).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: 'Apply to all items' });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Team for all items' }), { target: { value: 'facility' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Due by Day for all items' }), { target: { value: '-2' } });
    fireEvent.click(apply);
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'itemsBulk', ids: ['m365', 'card', 'fixed'], group: 'facility', due: -2 }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apply to all items' })).toBeNull());
  });

  it('keeps the choices and shows the refusal when the save fails', async () => {
    view(vi.fn().mockResolvedValue({ ok: false, error: 'This case changed. Refresh before trying again.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set for all items' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Assignment for all items' }), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This case changed.');
    expect(screen.getByRole('combobox', { name: 'Assignment for all items' })).toHaveValue('manual');
  });

  it('renders the shared strings in every supported locale', () => {
    view(undefined, 'ms');
    expect(screen.getByRole('button', { name: 'Tetapkan untuk semua item' })).toBeInTheDocument();
    const en = messages.onboardingV31.copy as Record<string, string>;
    for (const locale of ['ms', 'ta', 'th', 'vi', 'zh']) {
      const copy = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')).onboardingV31.copy as Record<string, string>;
      expect(Object.keys(en).filter(key => !(key in copy))).toEqual([]);
    }
  });
});

describe('pending Return and revoke', () => {
  it('previews each row\'s team, method and Day and saves "Set for all items" straight away', async () => {
    vi.mocked(readV9Case).mockResolvedValue({ ok: true, detail: { case: { id: 'fictional-case', revision: 1 }, calculation: null, personnelWritableKeys: [], returns: {
      held: [{ id: 'onboarding:card-item', name: 'Access Card', kind: 'device', group: 'group-tech', source: 'onboarding', catalogueId: 'card', requestNumber: 'IT-REQ-0006' }], selected: [], catalogue: [],
      rows: [{ previewId: 'onboarding:card-item', name: 'Access Card', kind: 'device', group: 'facility', method: 'rr', dueDay: -1, dueOn: '2026-11-29', cardStep: 'collect' }, { previewId: 'onboarding:card-item', name: 'Access Card', kind: 'system', group: 'group-tech', method: 'rr', dueDay: 0, dueOn: '2026-11-30', cardStep: 'deactivate' }],
    } } } as never);
    const command = vi.fn().mockResolvedValue({ ok: true });
    render(<NextIntlClientProvider locale="en" messages={messages}><PendingReturns c={fictionalV9Case({ state: 'pending', items: [] })} config={config} busy={false} command={command}/></NextIntlClientProvider>);
    await screen.findByText('Access Card');
    expect(screen.getByText('Facility · Round robin · due Day -1')).toBeInTheDocument();
    expect(screen.getByText('Group Tech · Round robin · due Day 0')).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set for all items' }));
    expect(screen.getAllByText('2 items')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assignment for all items' }), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all items' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'returnPresets', method: 'manual' }));
    expect(await screen.findByText('Saved. Owners are picked when you submit this case.')).toBeInTheDocument();
    expect(screen.queryByText('These preferences apply to this case when you save and submit it.')).toBeNull();
  });
});
