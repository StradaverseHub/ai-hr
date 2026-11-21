/** 259c6162 — Routing rules render in Assignment groups (module users only), not inside Approval workflows. */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { OnboardingSettings } from '../app/admin/lifecycle/onboarding/settings';
import { defaultConfig } from '../lib/onboarding-model';
const mocks = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ saveOnboardingConfig: mocks.save, saveOnboardingChecklistTasks: vi.fn() }));
const messages = (locale: string) => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
type Props = Parameters<typeof OnboardingSettings>[0];
function context(actor: { module: boolean; master: boolean } = { module: true, master: true }) {
  const config = defaultConfig('owner');
  config.groups.push({ id: 'regional-bp', name: 'Fictional Regional BP', members: [], limit: 8 });
  config.routings = [
    { id: 'main', name: 'Fictional main routing', rows: [{ id: 'm1', rules: {}, group: 'tech-bp' }, { id: 'm2', rules: { company: ['co-1'] }, group: 'regional-bp' }] },
    { id: 'spare', name: 'Fictional spare routing', rows: [{ id: 's1', rules: {}, group: 'tech-bp' }] },
  ];
  config.workflows[0]!.steps = [{ id: 'route', label: 'Business partner', type: 'routing', target: 'main', method: 'rr' }];
  return { config, revision: 7, actor: { id: 'owner', ...actor }, directory: [{ id: 'owner', name: 'Owner' }], checklistCounts: {}, loads: {}, availability: {}, matchCounts: {}, totalJoiners: 0 } as Props['context'];
}
const options = { businessGroup: [], company: [{ id: 'co-1', name: 'Fictional Company' }], department: [], title: [], grade: [], employmentType: [], supervisor: [] } as unknown as Props['options'];
const view = (props: Partial<Props> & { context: Props['context'] }, locale = 'en') => render(<NextIntlClientProvider locale={locale} messages={messages(locale)}><OnboardingSettings options={options} {...props}/></NextIntlClientProvider>);

it('shows Routing rules below the groups for a module user, with usage and translated labels', () => {
  view({ context: context(), initialTab: 'groups' });
  const section = screen.getByRole('region', { name: 'Routing rules' });
  expect(section.id).toBe('routing-rules');
  const main = within(section).getByRole('region', { name: 'Fictional main routing' });
  expect(main).toHaveTextContent('Used in: Standard approval · Business partner');
  expect(within(section).getByRole('region', { name: 'Fictional spare routing' })).toHaveTextContent('Not used by any approval step.');
  expect(within(main).getAllByRole('combobox', { name: 'Business group' })).toHaveLength(2);
  expect(within(main).getAllByRole('combobox', { name: 'Job title' })).toHaveLength(2);
  expect((within(main).getAllByRole('combobox', { name: 'Company' })[1] as HTMLSelectElement).value).toBe('co-1');
  // The groups list comes first, and a group card names the routing rules that point to it.
  const regional = screen.getByRole('region', { name: 'Fictional Regional BP' });
  expect(regional.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(regional).toHaveTextContent('Used by routing rule: Fictional main routing (1 row)');
});

it('hides Routing rules from a Master Admin without Onboarding access', () => {
  view({ context: context({ module: false, master: true }), initialTab: 'groups' });
  expect(screen.getByRole('region', { name: 'Fictional Regional BP' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Routing rules' })).toBeNull();
  expect(screen.queryByText('Fictional main routing')).toBeNull();
});

it('removes the routing editor from Approval workflows and links each routing step to Assignment groups', () => {
  const first = view({ context: context() });
  expect(screen.queryByText('Approver routing')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Routing rule name' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit steps', hidden: true }));
  expect(screen.getByRole('option', { name: 'Routing rule', hidden: true })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Manage routing rules in Assignment groups', hidden: true })).toHaveAttribute('href', '/admin/lifecycle/onboarding/groups#routing-rules');
  first.unmount();
  view({ context: context(), embedded: true });
  fireEvent.click(screen.getByRole('button', { name: 'Edit steps', hidden: true }));
  expect(screen.getByRole('link', { name: 'Manage routing rules in Assignment groups', hidden: true })).toHaveAttribute('href', '/lifecycle/v9?view=groups#routing-rules');
});

it('deleting a used routing rule asks for a replacement and re-points the steps in one save', async () => {
  vi.useFakeTimers(); mocks.save.mockResolvedValue({ error: null, revision: 8 });
  view({ context: context(), initialTab: 'groups', embedded: true });
  const main = screen.getByRole('region', { name: 'Fictional main routing' });
  fireEvent.click(within(main).getByRole('button', { name: 'Delete routing rule' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete routing rule Fictional main routing' });
  expect(dialog).toHaveTextContent('Standard approval · Business partner');
  const confirm = within(dialog).getByRole('button', { name: 'Delete and move steps' });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole('combobox', { name: 'Move these approval steps to' }), { target: { value: 'spare' } });
  fireEvent.click(confirm);
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(mocks.save).toHaveBeenCalledTimes(1);
  const saved = mocks.save.mock.calls[0]![1] as Props['context']['config'];
  expect(saved.routings.map(r => r.id)).toEqual(['spare']);
  expect(saved.workflows[0]!.steps[0]).toMatchObject({ id: 'route', type: 'routing', target: 'spare' });
});

it('a used routing rule cannot be deleted when there is no other routing rule', () => {
  const value = context(); value.config.routings = value.config.routings.filter(r => r.id === 'main');
  view({ context: value, initialTab: 'groups' });
  fireEvent.click(screen.getByRole('button', { name: 'Delete routing rule' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete routing rule Fictional main routing' });
  expect(dialog).toHaveTextContent('Create another routing rule first.');
  expect(within(dialog).getByRole('button', { name: 'Delete and move steps' })).toBeDisabled();
});

it('deleting a group a routing row points to asks for a replacement group first', async () => {
  vi.useFakeTimers(); mocks.save.mockResolvedValue({ error: null, revision: 8 });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  view({ context: context(), initialTab: 'groups', embedded: true });
  const regional = screen.getByRole('region', { name: 'Fictional Regional BP' });
  fireEvent.click(within(regional).getByRole('button', { name: 'Delete group' }));
  expect(within(regional).getByRole('alert')).toHaveTextContent('This group is used by routing rules: Fictional main routing. Choose a replacement group before deleting it.');
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(within(regional).getByRole('combobox', { name: 'Move unfinished tasks to this group if deleted' }), { target: { value: 'tech-bp' } });
  fireEvent.click(within(regional).getByRole('button', { name: 'Delete group' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(600); });
  expect(mocks.save).toHaveBeenCalledWith(7, expect.objectContaining({ groups: expect.not.arrayContaining([expect.objectContaining({ id: 'regional-bp' })]) }), { 'regional-bp': 'tech-bp' }, false);
});

it('renders the routing labels in a non-English locale', () => {
  view({ context: context(), initialTab: 'groups' }, 'ms');
  const section = screen.getByRole('region', { name: 'Peraturan penghalaan' });
  expect(within(section).getAllByRole('combobox', { name: 'Kumpulan perniagaan' })).toHaveLength(3);
  expect(within(section).getAllByRole('combobox', { name: 'Jawatan' })).toHaveLength(3);
  expect(within(section).getAllByRole('combobox', { name: 'Syarikat' })).toHaveLength(3);
  expect(within(section).queryByRole('combobox', { name: 'title' })).toBeNull();
  expect(within(section).getByRole('button', { name: 'Cipta peraturan penghalaan' })).toBeInTheDocument();
});
