/** Real mapping editor + the page's one real guard. Persistence is the action boundary mock. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { ClockingMappingInput } from '../packs/attendance/service';
import type { SaveMappingResult } from '../app/(app)/admin/attendance/file-mappings/actions';

const { save, push, refresh, router } = vi.hoisted(() => {
  const save = vi.fn<(id: string | null, input: ClockingMappingInput, nonce?: string) => Promise<SaveMappingResult>>();
  const push = vi.fn(), refresh = vi.fn();
  return {save, push, refresh, router: {push, refresh}};
});
vi.mock('next/navigation', () => ({useRouter: () => router, usePathname: () => '/admin/attendance/file-mappings/mapping/edit'}));
vi.mock('../app/(app)/admin/attendance/file-mappings/actions', () => ({saveClockingMappingAction: save}));
import { MappingForm } from '../app/(app)/admin/attendance/file-mappings/mapping-form';
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';

const t = en.clockingFile;
const initial: ClockingMappingInput = {name: 'Saved reader', deviceName: 'Gate A', description: 'Saved description', active: true,
  fileType: 'csv', layout: 'delimited', delimiter: ',', hasHeader: false, encoding: 'utf-8',
  fields: {cardId: {column: 1}, day: {column: 2}, month: {column: 3}, year: {column: 4}, hours: {column: 5}, minute: {column: 6}},
  inOutCodes: [], sampleFileName: 'reader.csv', sampleLines: ['EMP1,12,10,2026,09,00']};
function mount() {
  return render(<NextIntlClientProvider locale="en" messages={en}>
    <AttendanceSettingsNavigation/><a href="/admin/attendance/settings">Back to settings</a>
    <MappingForm mappingId="mapping" initial={initial}/>
  </NextIntlClientProvider>);
}
const form = () => document.querySelector<HTMLFormElement>('form[data-attendance-save-scope]')!;
const draft = () => JSON.parse(String(new FormData(form()).get('mappingDraft'))) as {
  name: string; fields: [string, {column?: number} | null][];
  drafts: {posFields: [string, {start: number; end: number} | null][]};
};
const name = () => screen.getByRole('textbox', {name: t.form.name}) as HTMLInputElement;
beforeEach(() => {
  save.mockReset(); push.mockReset(); refresh.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {cleanup(); __resetUnsavedGuards(); vi.restoreAllMocks();});

describe('mapping editor business snapshot and successful-save receipt', () => {
  it.each(['Back to settings', t.form.cancel])('preserves edits when %s is cancelled and navigates only after discard', async label => {
    mount(); expect(hasUnsavedChanges()).toBe(false);
    fireEvent.change(name(), {target: {value: 'Unsaved reader'}});
    await waitFor(() => expect(hasUnsavedChanges()).toBe(true));
    fireEvent.click(screen.getByText(label));
    expect(window.confirm).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled();
    expect(name()).toHaveValue('Unsaved reader');
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByText(label));
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledWith(label === 'Back to settings' ? '/admin/attendance/settings' : '/admin/attendance/file-mappings');
  });

  it('observes hidden column assignments and retains inactive fixed-width drafts', async () => {
    mount();
    const card = screen.getByRole('combobox', {name: t.fields.cardId});
    fireEvent.change(card, {target: {value: '7'}});
    await waitFor(() => expect(draft().fields.find(([field]) => field === 'cardId')?.[1]).toEqual({column: 7}));
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.change(card, {target: {value: '1'}});
    await waitFor(() => expect(hasUnsavedChanges()).toBe(false));
    fireEvent.click(screen.getByRole('radio', {name: t.form.layoutFixed}));
    fireEvent.change(screen.getByLabelText(`${t.fields.cardId} ${t.form.colStart}`), {target: {value: '1'}});
    fireEvent.change(screen.getByLabelText(`${t.fields.cardId} ${t.form.colEnd}`), {target: {value: '4'}});
    fireEvent.click(screen.getByRole('radio', {name: t.form.layoutDelimited}));
    await waitFor(() => expect(draft().drafts.posFields.find(([field]) => field === 'cardId')?.[1]).toEqual({start: 1, end: 4}));
    expect(hasUnsavedChanges()).toBe(true); // Current persisted layout is unchanged; the other draft is not lost.
    const unload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it('includes device, active state and asynchronously loaded sample content in the same observed snapshot', async () => {
    mount();
    fireEvent.change(screen.getByRole('textbox', {name: t.form.device}), {target: {value: 'Gate B'}});
    fireEvent.click(screen.getByRole('radio', {name: t.status.inactive}));
    const content = 'EMP2,13,10,2026,18,00';
    const file = new File([content], 'replacement.csv', {type: 'text/csv'});
    Object.defineProperty(file, 'arrayBuffer', {value: async () => new TextEncoder().encode(content).buffer});
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {target: {files: [file]}});
    await waitFor(() => expect(draft()).toMatchObject({deviceName: 'Gate B', active: false, sampleFileName: 'replacement.csv', sampleLines: [content]}));
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('already guards a replacement sample while its bytes are still being read', async () => {
    let finish!: (value: ArrayBuffer) => void;
    mount();
    const file = new File(['EMP2'], 'pending.csv', {type: 'text/csv'});
    Object.defineProperty(file, 'arrayBuffer', {value: () => new Promise<ArrayBuffer>(resolve => {finish = resolve;})});
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {target: {files: [file]}});
    await waitFor(() => expect(draft()).toMatchObject({drafts: {pendingSampleName: 'pending.csv'}}));
    expect(hasUnsavedChanges()).toBe(true); expect(screen.getByRole('button', {name: t.form.save})).toBeDisabled();
    fireEvent.click(screen.getByText('Back to settings')); expect(window.confirm).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled();
    await act(async () => {finish(new TextEncoder().encode('EMP2,13,10,2026,18,00').buffer);});
    await waitFor(() => expect(draft()).toMatchObject({sampleFileName: 'pending.csv', drafts: {pendingSampleName: ''}}));
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('keeps the actual mapping draft on browser Back cancellation and traverses only on discard', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    mount(); fireEvent.change(name(), {target: {value: 'Browser Back draft'}});
    await waitFor(() => expect(hasUnsavedChanges()).toBe(true));
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(window.confirm).toHaveBeenCalledTimes(1); expect(go).not.toHaveBeenCalled(); expect(name()).toHaveValue('Browser Back draft');
    vi.mocked(window.confirm).mockReturnValue(true); window.dispatchEvent(new PopStateEvent('popstate'));
    expect(window.confirm).toHaveBeenCalledTimes(2); expect(go).toHaveBeenCalledWith(-2);
  });

  it('keeps client validation failure dirty and does not invoke persistence', async () => {
    mount(); fireEvent.change(name(), {target: {value: ''}});
    const button = screen.getByRole('button', {name: t.form.save}) as HTMLButtonElement;
    expect(button.type).toBe('submit'); expect(button.form).toBe(form());
    await userEvent.setup().click(button);
    expect(screen.getByText(t.form.nameRequired)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled(); expect(hasUnsavedChanges()).toBe(true);
    expect(new FormData(form()).get('__attendanceSaveNonce')).toMatch(/^[a-f0-9]{32}$/);
  });

  it.each(['refused', 'rejected'])('retains values and the dirty baseline after a %s server save', async outcome => {
    if (outcome === 'refused') save.mockResolvedValue({ok: false, code: 'nameTaken', missing: [], problems: []});
    else save.mockRejectedValue(new Error('Network failure'));
    mount(); fireEvent.change(name(), {target: {value: 'Unsaved reader'}});
    await userEvent.setup().click(screen.getByRole('button', {name: t.form.save}));
    await waitFor(() => expect(screen.getByText(outcome === 'refused' ? t.form.nameTaken : t.form.fileUnreadable)).toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0][1].name).toBe('Unsaved reader');
    expect(save.mock.calls[0][2]).toMatch(/^[a-f0-9]{32}$/);
    expect(form()).not.toHaveAttribute('data-attendance-saved-receipt');
    // Error feedback can commit before React finishes the async save transition.
    await waitFor(() => expect(name()).not.toBeDisabled());
    expect(name()).toHaveValue('Unsaved reader'); expect(hasUnsavedChanges()).toBe(true);
    fireEvent.click(screen.getByText('Back to settings')); expect(window.confirm).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled();
  });

  it('freezes edits while saving and consumes only its matching persisted receipt before navigation', async () => {
    let finish!: (value: SaveMappingResult) => void;
    save.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    // A route transition must see a clean baseline, rather than relying on the component unmount.
    push.mockImplementation(() => expect(hasUnsavedChanges()).toBe(false));
    mount(); fireEvent.change(name(), {target: {value: 'Reviewed reader'}});
    await userEvent.setup().click(screen.getByRole('button', {name: t.form.save}));
    await waitFor(() => expect(name()).toBeDisabled());
    const nonce = save.mock.calls[0][2]!; expect(nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(hasUnsavedChanges()).toBe(true); expect(form()).toHaveAttribute('aria-busy', 'true');
    await userEvent.setup().type(name(), 'newer edit'); expect(name()).toHaveValue('Reviewed reader');
    // Drag/drop is not disabled by a fieldset; the real assignment handler must also refuse edits.
    const columnTwo = Array.from(document.querySelectorAll('th')).find(th => th.textContent?.includes('Column 2'))!;
    expect(columnTwo).toBeDefined();
    fireEvent.drop(columnTwo, {dataTransfer: {getData: () => 'cardId'}});
    expect(draft().fields.find(([field]) => field === 'cardId')?.[1]).toEqual({column: 1});
    await act(async () => {form().setAttribute('data-attendance-saved-receipt', 'unrelated-success');});
    expect(hasUnsavedChanges()).toBe(true); expect(push).not.toHaveBeenCalled();
    fireEvent.submit(form()); expect(save).toHaveBeenCalledTimes(1); // Busy capture must not replace the nonce.
    expect(new FormData(form()).get('__attendanceSaveNonce')).toBe(nonce);
    await act(async () => {finish({ok: true, id: 'saved-mapping', savedReceipt: nonce});});
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/attendance/file-mappings/saved-mapping'));
    expect(refresh).toHaveBeenCalledTimes(1); expect(window.confirm).not.toHaveBeenCalled(); expect(hasUnsavedChanges()).toBe(false);
    const unload = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
});
