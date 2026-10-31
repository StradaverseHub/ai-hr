/**
 * 1d58019a — Movement Settings, PROVED BY RENDERING.
 *
 * 1. The Delete explanation. Delete now shows on every event type and reason; on a row the service would
 *    refuse (built-in, or already used by recorded movements) it opens an explanation with Switch Off as the
 *    primary action instead of deleting. A source scan cannot tell whether the dialog actually opens, says
 *    why, and posts a SWITCH-OFF (not a delete) for the right code — so this renders it.
 * 2. The event-type configuration page's form inherits the retired dialog's promise (def44f29, formerly
 *    test/movement-type-dialog.dom.test.tsx): a refused save keeps the name, the chosen behaviour AND the
 *    description exactly as typed, and only a successful save navigates back to the list.
 *
 * Labels come from the REAL en.json, the way the server pages resolve them. The server actions are stubbed:
 * their behaviour is proved against a real database in test/termination-reason-catalog.test.ts and
 * test/movement-settings.test.ts. jsdom applies no CSS, so this catches rendering and interaction logic,
 * not a visual regression.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import messages from '../messages/en.json';

const { push, refresh, save, setTypeActive, setReasonActive } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  save: vi.fn(),
  setTypeActive: vi.fn(),
  setReasonActive: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, prefetch: _prefetch, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : String(href)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../app/(app)/admin/settings/movement/actions', () => ({
  saveMovementEventTypeAction: save,
  setMovementEventTypeActiveAction: setTypeActive,
  deleteMovementEventTypeAction: vi.fn(),
  saveTerminationReasonAction: vi.fn(),
  setTerminationReasonActiveAction: setReasonActive,
  deleteTerminationReasonAction: vi.fn(),
}));

import { DeleteExplanation } from '../app/(app)/admin/settings/movement/delete-explanation';
import { EventTypeForm, type EventTypeFormLabels } from '../app/(app)/admin/settings/movement/event-type-form';

const t = messages.movementSettings;

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  save.mockReset();
  setTypeActive.mockReset();
  setReasonActive.mockReset();
});

describe('1d58019a — Delete on a row that cannot be deleted explains why and offers Switch Off', () => {
  it('an in-use event type: the reason, the alternative, and a Switch Off that posts active=false for THIS code', async () => {
    const user = userEvent.setup();
    render(
      <DeleteExplanation
        target="type"
        code="redeployment"
        triggerLabel={t.delete}
        title={t.deleteBlocked.title.replace('{name}', 'Redeployment')}
        paragraphs={[t.deleteBlocked.inUse, t.deleteBlocked.switchOffInstead]}
        closeLabel={t.close}
        switchOffLabel={t.deactivate}
      />,
    );
    // Delete is THERE (it used to be missing on such rows) and opening it deletes nothing.
    await user.click(screen.getByRole('button', { name: t.delete }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('Redeployment cannot be deleted')).toBeInTheDocument();
    expect(within(dialog).getByText(t.deleteBlocked.inUse)).toBeInTheDocument();
    expect(within(dialog).getByText(t.deleteBlocked.switchOffInstead)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: t.delete }), 'no delete inside the explanation').toBeNull();

    const form = within(dialog).getByRole('button', { name: t.deactivate }).closest('form')!;
    const posted = new FormData(form);
    expect(posted.get('code')).toBe('redeployment');
    expect(posted.get('active'), 'it switches off; it never deletes').toBe('false');

    // Close leaves everything as it was.
    await user.click(within(dialog).getByRole('button', { name: t.close }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(setTypeActive).not.toHaveBeenCalled();
  });

  it('a built-in that is already switched off only explains — there is nothing to offer', async () => {
    const user = userEvent.setup();
    render(
      <DeleteExplanation
        target="type"
        code="transfer"
        triggerLabel={t.delete}
        title={t.deleteBlocked.title.replace('{name}', 'Transfer')}
        paragraphs={[t.deleteBlocked.builtIn, t.deleteBlocked.alreadyOff]}
        closeLabel={t.close}
        switchOffLabel={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: t.delete }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(t.deleteBlocked.builtIn)).toBeInTheDocument();
    expect(within(dialog).getByText(t.deleteBlocked.alreadyOff)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: t.deactivate })).toBeNull();
    expect(within(dialog).getByRole('button', { name: t.close })).toBeInTheDocument();
  });

  it('a used termination reason posts to the REASON switch-off, not the event-type one', async () => {
    const user = userEvent.setup();
    render(
      <DeleteExplanation
        target="reason"
        code="redundancy"
        triggerLabel={t.delete}
        title={t.deleteBlocked.title.replace('{name}', 'Redundancy')}
        paragraphs={[t.reasons.deleteBlocked.inUse, t.reasons.deleteBlocked.switchOffInstead]}
        closeLabel={t.close}
        switchOffLabel={t.deactivate}
      />,
    );
    await user.click(screen.getByRole('button', { name: t.delete }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: t.deactivate }));
    await waitFor(() => expect(setReasonActive).toHaveBeenCalledTimes(1));
    expect(setTypeActive).not.toHaveBeenCalled();
    const posted = setReasonActive.mock.calls[0]![0] as FormData;
    expect(posted.get('code')).toBe('redundancy');
    expect(posted.get('active')).toBe('false');
  });
});

/** Built the way app/(app)/admin/settings/movement/event-type-config-page.tsx builds them. */
const LABELS: EventTypeFormLabels = {
  sections: {
    general: t.config.sections.general,
    classification: t.config.sections.classification,
    description: t.config.sections.description,
  },
  name: t.columns.name,
  namePlaceholder: t.addNamePlaceholder,
  code: t.config.code,
  codeAuto: t.config.codeAuto,
  behaviour: t.columns.behaviour,
  behaviourPlaceholder: t.addBehaviourPlaceholder,
  behaviourHint: t.behaviourNotice,
  builtInBehaviour: t.builtInBehaviour,
  classificationHint: t.config.classificationHint,
  termination: t.classification.termination,
  nonTermination: t.classification.nonTermination,
  optional: t.config.optional,
  descriptionHint: t.config.descriptionHint,
  descriptionPlaceholder: t.config.descriptionPlaceholder,
  save: t.save,
  saving: t.saving,
  cancel: t.cancel,
};

const mountForm = (over: Partial<Parameters<typeof EventTypeForm>[0]> = {}) =>
  render(
    <EventTypeForm
      code="redeployment"
      builtIn={false}
      initialLabel="Redeployment"
      initialBehaviourKind="transfer"
      initialDescription=""
      behaviourLabel=""
      behaviourOptions={[
        { value: 'transfer', label: 'Transfer' },
        { value: 'promotion', label: 'Promotion' },
      ]}
      listHref="/admin/settings/movement"
      labels={LABELS}
      {...over}
    />,
  );

const q = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector(selector) as T | null;
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};

describe('1d58019a — the configuration page keeps its typing through a refused save', () => {
  it('a refused save keeps name, behaviour and description as typed, and does not navigate', async () => {
    const user = userEvent.setup();
    const reason = 'An event type with that name already exists.';
    save.mockResolvedValue({ ok: false, error: reason });
    mountForm();

    const name = q<HTMLInputElement>('input[name="label"]');
    await user.clear(name);
    await user.type(name, 'Promotion (Internal)');
    await user.selectOptions(q('select[name="behaviourKind"]'), 'promotion');
    await user.type(q<HTMLTextAreaElement>('textarea[name="description"]'), 'After a restructure.');
    await user.click(screen.getByRole('button', { name: t.save }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(q<HTMLInputElement>('input[name="label"]').value).toBe('Promotion (Internal)');
    expect(q<HTMLSelectElement>('select[name="behaviourKind"]').value).toBe('promotion');
    expect(q<HTMLTextAreaElement>('textarea[name="description"]').value).toBe('After a restructure.');
    expect(push).not.toHaveBeenCalled();

    const posted = save.mock.calls[0]![1] as FormData;
    expect(posted.get('code')).toBe('redeployment');
    expect(posted.get('label')).toBe('Promotion (Internal)');
    expect(posted.get('behaviourKind')).toBe('promotion');
    expect(posted.get('description')).toBe('After a restructure.');
    expect(posted.has('classification'), 'classification is read-only in Step 1 and never posted').toBe(false);
  });

  it('a successful save goes back to the list; Cancel is a link back to it', async () => {
    const user = userEvent.setup();
    save.mockResolvedValue({ ok: true });
    mountForm();
    expect(screen.getByRole('link', { name: t.cancel })).toHaveAttribute('href', '/admin/settings/movement');
    await user.click(screen.getByRole('button', { name: t.save }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/settings/movement'));
  });

  it('a built-in shows its behaviour read-only and the classification follows the behaviour', () => {
    mountForm({ code: 'termination', builtIn: true, initialBehaviourKind: 'termination', behaviourLabel: 'Termination' });
    expect(document.querySelector('select[name="behaviourKind"]'), 'no behaviour picker for a built-in').toBeNull();
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => r.disabled)).toBe(true);
    const checked = radios.find((r) => r.checked)!;
    expect(checked.closest('label')!.textContent!.trim()).toBe(t.classification.termination);
  });
});
