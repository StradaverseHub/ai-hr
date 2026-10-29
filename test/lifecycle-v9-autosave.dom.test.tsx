import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useV9Configuration } from '../app/lifecycle/v9/use-v9-configuration';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { Config, ConfigSaveReceipt } from '../lib/lifecycle-v9-model';
afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Result = { ok: true; result: ConfigSaveReceipt } | { ok: false; error: string };
function Harness({ initial, save, refreshed }: { initial: Config; save: (revision: number, value: Config) => Promise<Result>; refreshed: () => void }) {
  const { draft, edit, state, error, retry } = useV9Configuration(initial, save, refreshed, 50);
  return <><input aria-label="Workflow name" value={draft!.workflows[0].name} onChange={e => edit(value => { value.workflows[0].name = e.target.value; })}/><output>{state}</output><p>{error}</p><button onClick={retry}>Retry</button><button onClick={() => edit(value => { value.groups[0].name = 'Explicit local group edit'; })}>Edit group</button></>;
}
it('serializes saves, retains typing in flight and uses the actual acknowledged revisions', async () => {
  vi.useFakeTimers(); const first = deferred<Result>(), second = deferred<Result>(), save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), refreshed = vi.fn(), initial = v9Defaults(); initial.groupsRevision = 8;
  const view = render(<Harness initial={initial} save={save} refreshed={refreshed}/>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First edit' } });
  await act(async () => { vi.advanceTimersByTime(50); });
  expect(save.mock.calls[0][0]).toBe(initial.revision); expect(save.mock.calls[0][1].workflows[0].name).toBe('First edit');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Newer edit' } });
  view.rerender(<Harness initial={structuredClone(initial)} save={save} refreshed={refreshed}/>);
  await act(async () => { vi.advanceTimersByTime(50); }); expect(save).toHaveBeenCalledOnce();
  await act(async () => { first.resolve({ ok: true, result: { revision: initial.revision + 1, groupsRevision: 9, versionStamps: [{ templateId: initial.templates[0].id, version: initial.templates[0].versions[0].version, state: initial.templates[0].versions[0].state, at: '2026-10-29', by: 'Actual HR actor' }] } }); });
  expect(screen.getByRole('textbox')).toHaveValue('Newer edit'); expect(refreshed).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(50); });
  expect(save.mock.calls[1][0]).toBe(initial.revision + 1); expect(save.mock.calls[1][1]).toMatchObject({ groupsRevision: 9, workflows: expect.arrayContaining([expect.objectContaining({ name: 'Newer edit' })]) });
  expect(save.mock.calls[1][1].templates[0].versions[0]).toMatchObject({ at: '2026-10-29', by: 'Actual HR actor' });
  await act(async () => { second.resolve({ ok: true, result: { revision: initial.revision + 2, groupsRevision: 9 } }); });
  expect(refreshed).toHaveBeenCalledOnce();
  view.rerender(<Harness initial={structuredClone(initial)} save={save} refreshed={refreshed}/>);
  expect(screen.getByRole('textbox')).toHaveValue('Newer edit');
});
it('keeps a rejected draft visible and stops retrying until explicitly retried', async () => {
  vi.useFakeTimers(); const save = vi.fn().mockResolvedValue({ ok: false, error: 'Settings changed. Refresh before saving.' }), initial = v9Defaults();
  render(<Harness initial={initial} save={save} refreshed={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved review' } });
  await act(async () => { vi.advanceTimersByTime(50); });
  expect(screen.getByRole('textbox')).toHaveValue('Unsaved review'); expect(screen.getByText('Settings changed. Refresh before saving.')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(5000); }); expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(save).toHaveBeenCalledTimes(2);
});

it('refreshes the canonical group reference while preserving a pending workflow edit', async () => {
  vi.useFakeTimers(); const initial = v9Defaults(); initial.groupsRevision = 7;
  const save = vi.fn().mockResolvedValue({ok:true,result:{revision:2,groupsRevision:9}}), refreshed = vi.fn();
  const view = render(<Harness initial={initial} save={save} refreshed={refreshed}/>);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Unsaved workflow change'}});
  const fresh = structuredClone(initial); fresh.groupsRevision = 8; fresh.groups[0].name = 'Canonical group rename';
  view.rerender(<Harness initial={fresh} save={save} refreshed={refreshed}/>);
  expect(screen.getByRole('textbox')).toHaveValue('Unsaved workflow change');
  await act(async()=>{vi.advanceTimersByTime(50);});
  expect(save.mock.calls[0][1]).toMatchObject({groupsRevision:8,groups:expect.arrayContaining([expect.objectContaining({name:'Canonical group rename'})]),workflows:expect.arrayContaining([expect.objectContaining({name:'Unsaved workflow change'})])});
});
it('does not rebase an explicit group edit over another group owner revision', async () => {
  vi.useFakeTimers(); const initial = v9Defaults(); initial.groupsRevision = 7;
  const save = vi.fn().mockResolvedValue({ok:false,error:'Assignment groups changed. Refresh before saving.'}), refreshed = vi.fn();
  const view = render(<Harness initial={initial} save={save} refreshed={refreshed}/>);
  fireEvent.click(screen.getByRole('button',{name:'Edit group'}));
  const fresh=structuredClone(initial); fresh.groupsRevision=8; fresh.groups[0].name='Another owner edit';
  view.rerender(<Harness initial={fresh} save={save} refreshed={refreshed}/>);
  await act(async()=>{vi.advanceTimersByTime(50);});
  expect(save.mock.calls[0][1]).toMatchObject({groupsRevision:7,groups:expect.arrayContaining([expect.objectContaining({name:'Explicit local group edit'})])});
  expect(screen.getByText('Assignment groups changed. Refresh before saving.')).toBeVisible();
});
