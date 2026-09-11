/**
 * 1b87e8a0 re-build, PROVED BY RENDERING (added under def44f29, 2026-09-11).
 *
 * The movement-type dialog promised that a refused save keeps the dialog open with the typing intact, and
 * guarded it in source (test/movement-settings.test.ts: controlled fields, onReset cancelled). The source
 * guard was green over a real defect: react-dom 19.2 calls `form.reset()` during its commit phase with its
 * own event listener disabled, so the `reset` event never reached the onReset handler, and after a refused
 * save the behaviour <select> snapped from the chosen "Promotion" back to "Transfer" while React still held
 * "Promotion" — a re-submit would have posted the wrong behaviour. Only a render can see that, which is
 * why this file exists. The dialog now dispatches the action itself (no `action` prop), so React never
 * requests the reset; the refused-save case below is the line that proves it.
 *
 * Labels come from the REAL en.json, the way the server page resolves them. The server action is stubbed:
 * its behaviour is proved against a real database in test/movement-settings.test.ts.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import messages from '../messages/en.json';

const { push, refresh, save } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), save: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('../app/admin/settings/movement/actions', () => ({
  saveMovementEventTypeAction: save,
  setMovementEventTypeActiveAction: vi.fn(),
  deleteMovementEventTypeAction: vi.fn(),
}));

import { MovementTypeDialog, type MovementTypeDialogLabels } from '../app/admin/settings/movement/movement-type-dialog';

const t = messages.movementSettings;
/** Built the way app/admin/settings/movement/page.tsx builds editLabels. */
const LABELS: MovementTypeDialogLabels = {
  title: t.editTitle,
  hint: t.editHint,
  name: t.columns.name,
  namePlaceholder: t.addNamePlaceholder,
  behaviour: t.columns.behaviour,
  behaviourPlaceholder: t.addBehaviourPlaceholder,
  builtInBehaviour: t.builtInBehaviour,
  submit: t.save,
  saving: t.saving,
  cancel: t.cancel,
  close: t.close,
};
const BEHAVIOURS = [
  { value: 'transfer', label: 'Transfer' },
  { value: 'promotion', label: 'Promotion' },
];

const mount = () =>
  render(
    <MovementTypeDialog
      triggerLabel={t.edit}
      triggerClassName=""
      code="redeployment"
      builtIn={false}
      initialLabel="Redeployment"
      initialBehaviourKind="transfer"
      behaviourLabel=""
      behaviourOptions={BEHAVIOURS}
      labels={LABELS}
    />,
  );

const field = <T extends HTMLElement>(dialog: HTMLElement, selector: string): T => {
  const el = dialog.querySelector(selector) as T | null;
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  save.mockReset();
});

describe('1b87e8a0 — the movement-type dialog keeps its typing through a refused save', () => {
  it('a refused save keeps the dialog open with the name AND the chosen behaviour intact', async () => {
    const user = userEvent.setup();
    const reason = 'An event type named “Promotion (Internal)” already exists.';
    save.mockResolvedValue({ ok: false, error: reason });
    mount();
    await user.click(screen.getByRole('button', { name: t.edit }));
    const dialog = screen.getByRole('dialog');

    const name = field<HTMLInputElement>(dialog, 'input[name="label"]');
    await user.clear(name);
    await user.type(name, 'Promotion (Internal)');
    await user.selectOptions(field(dialog, 'select[name="behaviourKind"]'), 'promotion');
    expect(field<HTMLSelectElement>(dialog, 'select[name="behaviourKind"]').value).toBe('promotion');
    await user.click(within(dialog).getByRole('button', { name: t.save }));

    expect(await within(dialog).findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(field<HTMLInputElement>(dialog, 'input[name="label"]').value).toBe('Promotion (Internal)');
    // THE LINE THIS FILE EXISTS FOR: the select the post-action reset used to snap back to "Transfer".
    expect(field<HTMLSelectElement>(dialog, 'select[name="behaviourKind"]').value).toBe('promotion');
    expect(refresh).not.toHaveBeenCalled();

    expect(save).toHaveBeenCalledTimes(1);
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('code')).toBe('redeployment');
    expect(posted.get('label')).toBe('Promotion (Internal)');
    expect(posted.get('behaviourKind')).toBe('promotion');
  });

  it('a successful save refreshes the list under the dialog and closes it', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true });
    mount();
    await user.click(screen.getByRole('button', { name: t.edit }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(field(dialog, 'select[name="behaviourKind"]'), 'promotion');
    await user.click(within(dialog).getByRole('button', { name: t.save }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('behaviourKind')).toBe('promotion');
  });
});
