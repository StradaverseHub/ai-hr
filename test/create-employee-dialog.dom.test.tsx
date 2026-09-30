/**
 * CREATE NEW EMPLOYEE, AS A PROMPT — item 034a5080, proved by rendering.
 *
 * WHY RENDERING. The two things this item changes are both invisible to tsc, to `next build` and to a
 * source scan, and both of them can put a wrong Employee ID on a real employee:
 *
 *   1. THE READ-ONLY EMPLOYEE ID FIELD AND WHAT IT SENDS. The number shown in auto mode is
 *      `rule.sampleCode` — a PREVIEW of the next running number, computed on the server when the page was
 *      rendered. It must be DISPLAYED and must NOT become the `employeeCode` the create sends. Bind the
 *      field to that state (the obvious way to write a controlled input) and `resolveEmployeeIdMode` reads
 *      `hasCode: true` as Manual Key In: for a company whose setup allows manual override the hand-keyed
 *      branch runs and the counter is never advanced, and for a company whose setup FORBIDS it the server
 *      refuses the create outright. Nothing about that is a type error, and no static scan can see which
 *      value reached the action.
 *
 *   2. THE CONFIRMATION MUST NAME THE ISSUED ID, NOT THE PREVIEWED ONE. `issueEmployeeCode` advances the
 *      counter inside the create transaction and additionally SKIPS numbers already claimed by an
 *      employment or another draft, so the issued code legitimately differs from the preview — under two
 *      concurrent creates, or whenever a legacy hand-keyed code already sits on the next number. The
 *      confirmation is the one place a human is told which number they actually got. Showing the preview
 *      there would be a screen that lies precisely when it matters, and it would look right in every test
 *      that made the two values equal. So every create below returns a DIFFERENT code from the preview.
 *
 * It is also the MISSING_MESSAGE check for both new key groups: `NextIntlClientProvider` is given the real
 * en.json and next-intl throws on an unresolved key rather than painting one.
 *
 * Scope note, inherited from the other .dom tests: jsdom applies no CSS and computes no layout, so this
 * catches rendering and interaction logic, not a visual regression, and it is not a substitute for the
 * dev-server render check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import type { EmployeeIdRule } from '../lib/employee-id-mode';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * The two server actions the body calls. `createDraftAction` ALWAYS answers with a code that differs from
 * the preview — see the header. Recorded, not executed: what it does against a real database (the
 * transaction, the counter advance, the skip loop, the release on discard) is proved in
 * test/employee-draft-wizard.test.ts.
 */
const ISSUED = 'ACME000042X';
/** The four values the create carries. Typed, so the assertion on what was SENT is type-checked too. */
type CreateArgs = {
  companyId: string;
  fullName: string;
  primaryEmail: string;
  employeeIdMode?: string;
  employeeCode?: string;
};
const createDraftAction = vi.fn(async (_p: CreateArgs) => ({ id: 'draft-1', employeeCode: ISSUED }));
const checkEmployeeCodeAction = vi.fn(async (code: string) => ({ code, taken: false }));
vi.mock('../app/admin/personnel/new/actions', () => ({
  createDraftAction: (...a: unknown[]) => createDraftAction(...(a as [CreateArgs])),
  checkEmployeeCodeAction: (...a: unknown[]) => checkEmployeeCodeAction(...(a as [string])),
}));

const { CreateEmployeeDialog } = await import('../app/admin/personnel/create-employee-dialog');

const rule = (over: Partial<EmployeeIdRule> = {}): EmployeeIdRule => ({
  hasConfig: true,
  scope: 'company',
  prefix: 'ACME',
  suffix: 'X',
  numberLength: 6,
  nextNumber: 7,
  sampleCode: 'ACME000007X',
  allowManualOverride: false,
  ...over,
});

const COMPANIES = [
  { id: 'co-1', label: 'Acme Sdn Bhd' },
  { id: 'co-2', label: 'Beta Holdings' },
];
const RULES: Record<string, EmployeeIdRule> = {
  // Auto ONLY — the company whose setup forbids Manual Key In. The strictest case, and the one where
  // sending the preview as a typed code makes the server refuse outright.
  'co-1': rule(),
  // A DIFFERENT sequence, so "change the company and the ID follows" is a visible change of value and not
  // a re-render of the same string. Manual override allowed here, so the radio pair appears.
  'co-2': rule({ prefix: 'BETA', suffix: '', sampleCode: 'BETA000199', nextNumber: 199, allowManualOverride: true }),
};

const wrap = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CreateEmployeeDialog triggerLabel="Create new employee" companies={COMPANIES} employeeIdRules={RULES} />
    </NextIntlClientProvider>,
  );

const w = messages.people.wizard;

/** Open the prompt and choose a company. Returns the user-event instance for further interaction. */
async function openWith(companyLabel: string) {
  const user = userEvent.setup();
  wrap();
  await user.click(screen.getByRole('link', { name: 'Create new employee' }));
  const dialog = await screen.findByRole('dialog');
  await user.selectOptions(within(dialog).getByRole('combobox'), companyLabel);
  return { user, dialog };
}

const autoField = () => document.querySelector<HTMLInputElement>('input[data-auto-employee-id]');

beforeEach(() => {
  push.mockClear();
  refresh.mockClear();
  createDraftAction.mockClear();
  checkEmployeeCodeAction.mockClear();
});

describe('the prompt replaces the separate full screen', () => {
  it('the trigger opens a dialog over the list, and is STILL a link to the standalone route', async () => {
    const user = userEvent.setup();
    wrap();
    const trigger = screen.getByRole('link', { name: 'Create new employee' });
    // ⌘-click, middle-click and a JS-less browser must all still reach the full screen: the route is the
    // tour's target and every draft row's ?draft= destination, and it is deliberately not deleted.
    expect(trigger.getAttribute('href')).toBe('/admin/personnel/new');
    // The onboarding tour anchors on this attribute (lib/module-tours.json → people.hire), and it moved
    // here with the button it belongs to.
    expect(trigger.getAttribute('data-tour')).toBe('people-hire');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(w.title)).toBeTruthy();
    // Nothing has been created by OPENING it. Requirement 8 of the item: Cancel creates nothing, and so
    // does merely looking.
    expect(createDraftAction).not.toHaveBeenCalled();
  });

  it('Cancel closes the prompt and creates nothing', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    await user.click(within(dialog).getByRole('button', { name: w.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(createDraftAction).not.toHaveBeenCalled();
  });
});

describe('the Employee ID is a read-only field, not a sentence', () => {
  it('shows the applicable running number in a field with an Auto-generated badge', async () => {
    const { dialog } = await openWith('Acme Sdn Bhd');
    const field = autoField();
    expect(field, 'the auto Employee ID field is rendered').toBeTruthy();
    expect(field!.value).toBe('ACME000007X');
    expect(within(dialog).getByText(w.employeeId.autoGenerated)).toBeTruthy();
    // The label above it is the Employee ID heading, so the number reads as a fact about the employee
    // rather than as an explanation (requirement 5).
    expect(field!.closest('label')?.textContent).toContain(w.employeeId.heading);
  });

  it('is readOnly and NOT disabled — a disabled input is not submitted at all (CLAUDE.md §8)', async () => {
    await openWith('Acme Sdn Bhd');
    const field = autoField()!;
    expect(field.readOnly).toBe(true);
    expect(field.disabled).toBe(false);
    // And it stays reachable, so the number can be selected and copied onto an offer letter.
    expect(field.getAttribute('tabindex')).toBeNull();
  });

  it('THE RETIRED SENTENCE IS GONE from the screen, and its key is still in every locale', () => {
    // The reporter quoted this sentence word for word and asked for a field instead:
    //   "S000001E is the ID that will be issued and reserved the moment you press Create."
    // `import.meta.url` is an http:// URL under the jsdom project, so paths are resolved from the repo
    // root (vitest's cwd) rather than from this file — the same reason test/dom-setup.ts exists.
    const src = readFileSync(resolve(process.cwd(), 'app/admin/personnel/new/create-form.tsx'), 'utf8');
    // COMMENTS STRIPPED FIRST, for the reason test/function-access.test.ts strips them: the comment that
    // explains the retirement QUOTES the call it retired, and the first version of this assertion was
    // satisfied — in the failing direction — by that prose. A guard that prose can answer is not a guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(code).toContain("t('employeeId.autoGenerated')");
    expect(code).not.toContain("t('employeeId.reserveNote')");
    // RETIRED, NOT DELETED (CLAUDE.md §8). The key stays in all six locales: deleting it would strand any
    // consumer we have not found, and test/employee-draft-wizard.test.ts still requires it non-empty.
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(readFileSync(resolve(process.cwd(), `messages/${loc}.json`), 'utf8'));
      expect(String(m.people.wizard.employeeId.reserveNote ?? '').trim(), `${loc} reserveNote`).not.toBe('');
    }
  });

  it('changing the company re-derives the displayed ID from that company\'s sequence', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    expect(autoField()!.value).toBe('ACME000007X');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'Beta Holdings');
    // Requirement 8. The rule is re-read per company; nothing is cached from the first choice.
    expect(autoField()!.value).toBe('BETA000199');
  });

  it('THE PREVIEW IS NOT SENT AS A HAND-KEYED ID — the auto branch posts an empty employeeCode', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    await user.type(within(dialog).getByLabelText(/Full name/), 'Nur Aisyah');
    await user.type(within(dialog).getByLabelText(/Email/), 'nur@acme.test');
    expect(autoField()!.value).toBe('ACME000007X');
    await user.click(within(dialog).getByRole('button', { name: w.createDraft }));

    expect(createDraftAction).toHaveBeenCalledTimes(1);
    const sent = createDraftAction.mock.calls[0][0];
    // THE ASSERTION THIS FILE EXISTS FOR. `co-1` forbids Manual Key In, so a non-empty employeeCode here
    // is the server refusal "was entered by hand, but the selected company's Employee ID Auto Running
    // Number Setup does not allow manual entry" — every create against that company, refused, because a
    // read-only field was wired to the value it displays.
    expect(sent.employeeCode ?? '', 'the previewed ID must not travel as a typed code').toBe('');
    expect(sent.companyId).toBe('co-1');
  });
});

describe('the confirmation names the ID that was actually issued', () => {
  it('reports the SERVER\'s code, never the previewed one', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    const previewed = autoField()!.value;
    expect(previewed).toBe('ACME000007X');
    await user.type(within(dialog).getByLabelText(/Full name/), 'Nur Aisyah');
    await user.type(within(dialog).getByLabelText(/Email/), 'nur@acme.test');
    await user.click(within(dialog).getByRole('button', { name: w.createDraft }));

    expect(await screen.findByText(w.created.heading)).toBeTruthy();
    const issued = document.querySelector('[data-issued-employee-id]');
    expect(issued, 'the confirmation renders the issued Employee ID').toBeTruthy();
    // The whole point: the counter advanced inside the transaction and skipped whatever was already
    // claimed, so what HR is told is the server's answer and not the number they were shown a moment ago.
    expect(issued!.textContent).toBe(ISSUED);
    expect(issued!.textContent).not.toBe(previewed);
    // And it names the person and the company alongside it, so the receipt is checkable.
    const receipt = document.querySelector('[data-created-employee]')!;
    expect(receipt.textContent).toContain('Nur Aisyah');
    expect(receipt.textContent).toContain('Acme Sdn Bhd');
    // The form body is gone — the four questions are answered and the record exists; re-pressing Create
    // must not be possible.
    expect(screen.queryByRole('button', { name: w.createDraft })).toBeNull();
  });

  it('offers Continue filling in details (to the draft) and Back to the list (close + refresh)', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    await user.type(within(dialog).getByLabelText(/Full name/), 'Nur Aisyah');
    await user.type(within(dialog).getByLabelText(/Email/), 'nur@acme.test');
    await user.click(within(dialog).getByRole('button', { name: w.createDraft }));
    await screen.findByText(w.created.heading);

    await user.click(screen.getByRole('button', { name: w.created.continue }));
    // Today's behaviour, kept: the continue form for the record that now exists.
    expect(push).toHaveBeenCalledWith('/admin/personnel/new?draft=draft-1');

    await user.click(screen.getByRole('button', { name: w.created.backToList }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The list has to show the new Draft row without the reporter reloading the screen they never left.
    expect(refresh).toHaveBeenCalled();
  });

  it('re-opening the prompt starts a fresh create, not the last receipt', async () => {
    const { user, dialog } = await openWith('Acme Sdn Bhd');
    await user.type(within(dialog).getByLabelText(/Full name/), 'Nur Aisyah');
    await user.type(within(dialog).getByLabelText(/Email/), 'nur@acme.test');
    await user.click(within(dialog).getByRole('button', { name: w.createDraft }));
    await screen.findByText(w.created.heading);
    await user.click(screen.getByRole('button', { name: w.created.backToList }));

    await user.click(screen.getByRole('link', { name: 'Create new employee' }));
    const again = await screen.findByRole('dialog');
    expect(within(again).getByText(w.title)).toBeTruthy();
    expect(screen.queryByText(w.created.heading)).toBeNull();
    // A blank form: the company is unchosen, so there is no ID on screen to mistake for the last one.
    expect(autoField()).toBeNull();
  });
});
