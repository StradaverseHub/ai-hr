import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { SystemLabelsGrid, type GridRecord } from '../components/system-labels-grid';

const navigation = vi.hoisted(() => ({
  query: '', pending: [] as string[], requests: [] as string[], listeners: new Set<() => void>(),
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const router = { replace: (href: string) => {
    navigation.requests.push(href);
    navigation.pending.push(href);
  } };
  return {
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(
      listener => { navigation.listeners.add(listener); return () => { navigation.listeners.delete(listener); }; },
      () => navigation.query,
      () => navigation.query,
    )),
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  navigation.query = '';
  navigation.pending.length = 0;
  navigation.requests.length = 0;
  navigation.listeners.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

// Apply each requested URL as a later navigation commit. A permanently empty useSearchParams mock
// cannot expose an input losing focus when paging unmounts its row before clamping back again.
async function settleNavigation() {
  let commits = 0;
  while (navigation.pending.length) {
    expect(++commits, 'pagination must settle without a navigation loop').toBeLessThan(8);
    const href = navigation.pending.shift()!;
    await act(async () => {
      navigation.query = href.startsWith('?') ? href.slice(1) : new URL(href, 'http://localhost').search.slice(1);
      for (const listener of navigation.listeners) listener();
    });
  }
}

function savedRow(number: number): GridRecord {
  return {
    id: `saved-${number}`, companyId: 'company-a', code: '', name: `SAVED_${number}`, title: '',
    jobFamily: '', label: '', businessUnitId: null, headEmploymentId: null, description: '',
    isGlobal: false, archived: false, inUse: false, assignedCompanyIds: ['company-a'],
    createdAt: null, lastUpdatedAt: null, lastUpdatedBy: null,
  };
}
function mount(count: number) {
  const save = vi.fn(async () => ({ ok: false as const, rowErrors: [], message: 'Fixture save refusal' }));
  const result = render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
    <SystemLabelsGrid
      data={{ department: Array.from({ length: count }, (_, i) => savedRow(i + 1)), position: [], cost_center: [], business_unit: [] }}
      companies={[{ id: 'company-a', name: 'Company A' }]}
      writableCompanyIds={['company-a']} isGroupAdmin
      actions={{ save, setCriteria: vi.fn(async () => ({ ok: true as const })),
        assign: vi.fn(async () => ({ ok: true as const })), unassign: vi.fn(async () => ({ ok: true as const })),
        copyToCompanies: vi.fn(async () => ({ ok: true as const })) }}
    />
  </NextIntlClientProvider>);
  return { ...result, save };
}
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')];
const code = (row: HTMLElement) => row.querySelector<HTMLInputElement>('input[data-cell^="name:"]')!;
const add = () => screen.getByRole('button', { name: messages.admin.systemLabels.addRow });

describe('System Labels draft focus after real query-state navigation', () => {
  it('keeps each prepended Code focused on the first page without navigating away or losing earlier unsaved rows', async () => {
    const user = userEvent.setup(), { container } = mount(2);
    await user.clear(code(rows(container)[0]));
    await user.type(code(rows(container)[0]), 'Existing unsaved edit');
    await user.click(add());
    await settleNavigation();
    expect(code(rows(container)[0])).toHaveFocus();
    expect(navigation.requests).toEqual([]);
    await user.type(code(rows(container)[0]), 'First unsaved draft');
    await user.click(add());
    await settleNavigation();
    expect(code(rows(container)[0])).toHaveFocus();
    expect(rows(container).map(row => code(row).value)).toEqual([
      '', 'First unsaved draft', 'Existing unsaved edit', 'SAVED_2',
    ]);
    expect(navigation.requests).toEqual([]);
  });

  it('returns from zero-based page one to the first page, focuses the draft and retains off-page dirty input for Save', async () => {
    navigation.query = 'page=1&size=25';
    const user = userEvent.setup(), { container, save } = mount(30);
    expect(code(rows(container)[0]).value).toBe('SAVED_26');
    await user.clear(code(rows(container)[0]));
    await user.type(code(rows(container)[0]), 'Off-page unsaved edit');
    await user.click(add());
    await settleNavigation();
    expect(new URLSearchParams(navigation.query).get('page')).toBeNull();
    expect(new URLSearchParams(navigation.query).get('size')).toBe('25');
    expect(code(rows(container)[0])).toHaveFocus();
    expect(code(rows(container)[0]).value).toBe('');
    await user.type(code(rows(container)[0]), 'First unsaved draft');
    await user.click(add());
    await settleNavigation();
    expect(code(rows(container)[0])).toHaveFocus();
    expect(code(rows(container)[1]).value).toBe('First unsaved draft');
    await user.type(code(rows(container)[0]), 'Newest unsaved draft');
    await user.click(screen.getByRole('button', { name: messages.admin.systemLabels.saveAll }));
    expect(save).toHaveBeenCalledWith('department', expect.objectContaining({
      creates: [expect.objectContaining({ name: 'Newest unsaved draft' }), expect.objectContaining({ name: 'First unsaved draft' })],
      updates: [expect.objectContaining({ id: 'saved-26', name: 'Off-page unsaved edit' })],
    }));
  });
});
