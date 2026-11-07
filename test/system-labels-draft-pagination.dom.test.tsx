import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
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
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

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

const companyId='00000000-0000-0000-0000-000000000001';
const headId='00000001-0000-0000-0000-000000005001';
const head={employmentId:headId,companyId,employeeCode:'HEAD05001',name:'Newly chosen ended head'};
const headLabel='Newly chosen ended head (HEAD05001)';
function savedRow(number: number): GridRecord {
  return {
    id: `saved-${number}`, companyId, code: '', name: `SAVED_${number}`, title: '',
    jobFamily: '', label: '', businessUnitId: null, headEmploymentId: null, description: '',
    isGlobal: false, archived: false, inUse: false, assignedCompanyIds: [companyId],
    createdAt: null, lastUpdatedAt: null, lastUpdatedBy: null,
  };
}
function mount(count: number,retainedHead=false) {
  const save = vi.fn(async () => ({ ok: false as const, rowErrors: [], message: 'Fixture save refusal' }));
  const result = render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
    <SystemLabelsGrid
      data={{ department: Array.from({ length: count }, (_, i) => ({...savedRow(i + 1),headEmploymentId:retainedHead&&i===0?headId:null})), position: [], cost_center: [], business_unit: [] }}
      companies={[{ id: companyId, name: 'Company A' }]}
      headByCompany={retainedHead?{[companyId]:[{id:headId,label:'Original retained head label'}]}:{}}
      writableCompanyIds={[companyId]} isGroupAdmin
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
  it('retains a new selected head label in its Grid row and duplicate through page and category remounts, without adding display metadata to Save',async()=>{
    const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>{const p=JSON.parse(String(init.body));return {ok:true,json:async()=>({companyId,query:p.query.trim(),offset:p.offset,limit:25,total:1,rows:[head],selected:p.selectedId===headId?head:null})};});vi.stubGlobal('fetch',fetch);
    const user=userEvent.setup(),{container,save}=mount(30);
    const first=rows(container)[0];await user.click(within(first).getByText(messages.employeePanel.searchLabel));
    await within(first).findByRole('option',{name:headLabel});await user.selectOptions(within(first).getByRole('combobox',{name:messages.admin.organization.fieldHead}),headId);
    await user.click(within(first).getByRole('button',{name:messages.admin.systemLabels.duplicateRow}));await settleNavigation();
    const assertHead=(key:string)=>{const row=container.querySelector<HTMLElement>('[data-row-key="'+key+'"]')!;const select=within(row).getByRole('combobox',{name:messages.admin.organization.fieldHead});expect(select).toHaveValue(headId);expect(within(select).getByRole('option',{name:headLabel})).toBeInTheDocument();expect(within(select).queryByRole('option',{name:messages.admin.systemLabels.headUnavailable})).toBeNull();};
    assertHead('draft-1');assertHead('saved-1');
    await user.click(within(container.querySelector('[data-ui-pager]')! as HTMLElement).getByRole('button',{name:messages.pagination.next,exact:true}));await settleNavigation();
    expect(container.querySelector('[data-row-key="saved-1"]')).toBeNull();expect(container.querySelector('[data-row-key="draft-1"]')).toBeNull();
    await user.click(within(container.querySelector('[data-ui-pager]')! as HTMLElement).getByRole('button',{name:messages.pagination.previous,exact:true}));await settleNavigation();assertHead('draft-1');assertHead('saved-1');
    await user.click(screen.getByRole('button',{name:new RegExp('^'+messages.admin.systemLabels.category.business_unit)}));await settleNavigation();
    expect(container.querySelector('[data-row-key="saved-1"]')).toBeNull();
    await user.click(screen.getByRole('button',{name:new RegExp('^'+messages.admin.systemLabels.category.department)}));await settleNavigation();assertHead('draft-1');assertHead('saved-1');
    const calls=fetch.mock.calls.length;await user.click(screen.getByRole('button',{name:messages.admin.systemLabels.saveAll}));
    expect(save).toHaveBeenCalledWith('department',expect.objectContaining({creates:[expect.objectContaining({key:'draft-1',headEmploymentId:headId})],updates:[expect.objectContaining({id:'saved-1',headEmploymentId:headId})]}));
    expect(JSON.stringify(save.mock.calls)).not.toContain('headDisplay');expect(JSON.stringify(save.mock.calls)).not.toContain(headLabel);expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it.each(['missing','forbidden'] as const)('remembers a fresh %s selected-head refusal across Grid remounts without dirtying the label or clearing its ID',async refusal=>{
    let denied=false;vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{const p=JSON.parse(String(init.body));return denied&&refusal==='forbidden'?{ok:false,status:403}:{ok:true,json:async()=>({companyId,query:p.query.trim(),offset:p.offset,limit:25,total:denied?0:1,rows:denied?[]:[head],selected:denied?null:head})};}));
    const user=userEvent.setup(),{container,save}=mount(2,true);
    const first=rows(container)[0];await user.click(within(first).getByText(messages.employeePanel.searchLabel));await within(first).findByRole('option',{name:headLabel});
    expect(screen.getByRole('button',{name:messages.admin.systemLabels.saveAll})).toBeDisabled();
    await user.click(within(first).getByText(messages.employeePanel.searchLabel));await waitFor(()=>expect(first.querySelector('details')).not.toHaveAttribute('open'));
    denied=true;await user.click(within(first).getByText(messages.employeePanel.searchLabel));
    await within(first).findByRole('option',{name:messages.admin.systemLabels.headUnavailable});
    await user.click(screen.getByRole('button',{name:new RegExp('^'+messages.admin.systemLabels.category.business_unit)}));await settleNavigation();
    await user.click(screen.getByRole('button',{name:new RegExp('^'+messages.admin.systemLabels.category.department)}));await settleNavigation();
    const select=within(rows(container)[0]).getByRole('combobox',{name:messages.admin.organization.fieldHead});expect(select).toHaveValue(headId);expect(within(select).getByRole('option',{name:messages.admin.systemLabels.headUnavailable})).toBeInTheDocument();
    expect(within(select).queryByRole('option',{name:headLabel})).toBeNull();expect(screen.getByRole('button',{name:messages.admin.systemLabels.saveAll})).toBeDisabled();expect(save).not.toHaveBeenCalled();
  });
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
