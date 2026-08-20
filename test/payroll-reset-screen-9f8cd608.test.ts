/**
 * 9f8cd608 — "Reset payroll does nothing when clicked", and it did nothing for a reason no test could see.
 *
 * WHAT WAS BROKEN, MEASURED IN A REAL BROWSER RATHER THAN ARGUED. Reset payroll was a
 * `<form action={resetAction}>` carrying a ConfirmSubmit, rendered INSIDE the Payroll Process row menu
 * (app/payroll/row-actions.tsx). That panel is `position: fixed` and closes itself on ANY scroll captured
 * at the window. ConfirmSubmit is a Radix AlertDialog: its body is portalled to the document, but its
 * OWNER is the menu subtree — so when the menu closed, the dialog unmounted with it.
 *
 * Chromium, a real processed run, 1280×720 (where the table's `overflow-x-auto` wrapper is genuinely
 * scrollable): clicking the item produced ONE scroll event on `DIV.overflow-x-auto`, after which
 * `[role=menu]` = 0 and `[role=alertdialog]` = 0. Nothing on screen. At 1600 and 1920 wide, where the
 * wrapper needs no scroll, the same click opened the dialog normally; that width dependence is why it read
 * as intermittent. And jsdom computes no layout, so nothing scrolls there and a DOM test of the old code
 * passed — as did tsc, the suite, `next build` and a 200 from the route.
 *
 * WHAT PRODUCES THAT SCROLL WAS NOT ISOLATED, and this file does not assert it. The focus move into the
 * portalled dialog and react-remove-scroll's body scroll-lock (`overflow: hidden` + padding compensation,
 * which reflows the page and can clamp the wrapper's `scrollLeft`) both fit the measurement and both fit
 * the width dependence. The established fact is the one the guards below rest on: OPENING THE DIALOG
 * PRODUCES A SCROLL, and this panel closes on any scroll from anywhere, so a dialog it owns is destroyed
 * by its own opening. Which candidate it is would change nothing about the fix.
 *
 * WHAT THIS FILE GUARDS, and every case is a SOURCE-SHAPE assertion for the reason the sibling payroll
 * guards are: a menu placement is a string, and tsc is indifferent to it.
 *
 *   A. THE PATTERN CANNOT COME BACK. The row menu is handed LINKS ONLY — no form, no ConfirmSubmit, no
 *      submit button — and page.tsx is still its only caller. This is the case that fails if the fix is
 *      reverted, and it is the point of the file.
 *   B. THE DRAFT DELETE STAYS WHERE IT IS. It is the other ConfirmSubmit on this screen and it sits
 *      OUTSIDE the menu, in the flex cell — untouched, and asserted to still be outside.
 *   C. THE SCREEN SAYS WHICH RUN. Company, period, payroll cycle, payment date and employee count, before
 *      anything can be pressed. A confirmation that says only "this payroll run" is the hazard being
 *      removed, not the fix.
 *   D. THE RESET RULE DID NOT MOVE. The visibility conditions stay on the list's server page and the
 *      screen decides nothing the service decides.
 *   E. THE RETURN PATH SURVIVES THE EXTRA HOP. list → screen (`?from=`) → action (posted `from`), so
 *      `payrollListAfterReset` still lands the operator on their own filtered list.
 *   F. The route has a screen column, and the copy resolves in all six catalogues.
 *   G. A REFUSAL COMES BACK ON THIS SCREEN, translated — the plan's "shows a success or error message"
 *      half, which used to redirect to the run screen and lose the filter query with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGISTERED_ROUTES } from '../lib/permissions';
import { payrollRunTypeEnum } from '../db/schema';

const ROOT = path.resolve(__dirname, '..');
/** Source with comments stripped — a comment DESCRIBING a control must never satisfy a guard for it, and
 *  this file's subject is a set of comments that talk about forms and dialogs at length. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LIST = code('app/payroll/page.tsx');
const SCREEN = code('app/payroll/[batchId]/reset/page.tsx');
const ISLAND = code('app/payroll/row-actions.tsx');

/** Everything BETWEEN the row-action island's tags — i.e. exactly what the ⋯ menu is handed. */
const menuBody = (() => {
  const open = LIST.indexOf('<PayrollRowActions');
  expect(open, 'the list no longer renders the row-action island').toBeGreaterThan(-1);
  const bodyStart = LIST.indexOf('>', open) + 1;
  const close = LIST.indexOf('</PayrollRowActions>');
  expect(close, 'the island is self-closing — it has no actions in it').toBeGreaterThan(bodyStart);
  return LIST.slice(bodyStart, close);
})();

describe('9f8cd608 · A — the row menu is handed links only', () => {
  it('every element inside the menu is a <Link> — no form, no dialog, no submit button', () => {
    /**
     * THE CASE THAT FAILS IF THE FIX IS REVERTED. A confirmation dialog inside this panel is destroyed by
     * the scroll its own opening emits, and "opened and destroyed" is indistinguishable, from the
     * operator's side, from "nothing happened". Asserting the ABSENCE of ConfirmSubmit alone would be
     * satisfied by a plain `<button onClick>` that has the identical problem, so the shape is pinned
     * positively: the only tag the menu may contain is Link.
     */
    const tags = [...new Set([...menuBody.matchAll(/<([A-Za-z][\w.]*)/g)].map((m) => m[1]))].sort();
    expect(tags, `the row menu contains something other than a link: ${tags.join(', ')}`).toEqual(['Link']);
    expect(menuBody, 'a confirmation dialog is back inside a panel that closes underneath it').not.toContain(
      'ConfirmSubmit',
    );
    expect(menuBody, 'a form is back inside the menu').not.toContain('<form');
    // Three actions, three links — nothing was lost on the way to links-only.
    expect((menuBody.match(/<Link/g) ?? []).length).toBe(3);
    for (const label of ["tb('reprocessAction')", "tb('removeAction')", "tb('resetPayroll')"]) {
      expect(menuBody, `the menu lost ${label}`).toContain(label);
    }
  });

  it('the list no longer imports the action at all — the form went with the dialog', () => {
    expect(LIST).toContain("import { deleteDraftBatchAction } from './actions';");
    expect(LIST, 'app/payroll/page.tsx still imports resetAction').not.toContain('resetAction');
  });

  it('page.tsx is the island’s ONLY caller, so "links only" covers every menu there is', () => {
    // A second caller could reintroduce the pattern somewhere this file does not look. Today there is
    // none; if one appears, this fails and the new call site must be covered above.
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx') && fs.readFileSync(p, 'utf8').includes('<PayrollRowActions')) {
          callers.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(path.join(ROOT, 'app'));
    expect(callers).toEqual(['app/payroll/page.tsx']);
  });

  it('the island itself is unchanged in the ways that matter — it still places, and still closes on scroll', () => {
    // The fix is at the CALL SITE, not here: a fixed panel measured once must still close when anything
    // moves the row under it, and it must still be fixed or the table's overflow wrapper clips it shut.
    expect(ISLAND).toMatch(/window\.addEventListener\('scroll', close, true\)/);
    expect(ISLAND).toMatch(/window\.addEventListener\('resize', close\)/);
    expect(ISLAND).toMatch(/className="fixed z-50/);
    expect(ISLAND).toMatch(/getBoundingClientRect\(\)/);
    // And the header no longer documents a hazard that no longer exists (rule: a comment this change
    // makes false is a defect). The raw source is read here — comments are the subject.
    const RAW_ISLAND = fs.readFileSync(path.join(ROOT, 'app/payroll/row-actions.tsx'), 'utf8');
    expect(RAW_ISLAND, 'the island still describes itself as carrying a reset form').not.toContain('resetAction');
    expect(RAW_ISLAND, 'the island still describes itself as carrying a dialog').not.toContain('ConfirmSubmit');
  });
});

describe('9f8cd608 · B — the draft delete is the other ConfirmSubmit, and it stays outside the menu', () => {
  it('it is still on the row, still a form, and still NOT inside the panel', () => {
    // Draft rows were never the problem: this control sits in the flex cell beside View, not inside a
    // panel that closes on scroll, so its dialog has no owner to be unmounted by. Moving it in would
    // recreate the defect on a different button.
    expect(LIST).toMatch(/<form action=\{deleteDraftBatchAction\}>/);
    expect(LIST).toContain('<ConfirmSubmit');
    expect(menuBody, 'the draft delete was moved into the menu').not.toContain('deleteDraftBatchAction');
    expect(LIST.indexOf('deleteDraftBatchAction', LIST.indexOf('<tr key={b.id}'))).toBeLessThan(
      LIST.indexOf('<PayrollRowActions'),
    );
  });
});

describe('9f8cd608 · C — the screen states WHICH run before anything can be pressed', () => {
  it('company, period, payroll cycle, payment date and employee count are all named', () => {
    // The five facts the plan promised. The old dialog said "this payroll process" and nothing else, on an
    // action that deletes a whole run's payslips.
    for (const [fact, token] of [
      ['company', "tl('colCompany')"],
      ['period', "t('summaryPeriod')"],
      ['payroll cycle', "t('summaryCycle')"],
      ['payment date', "t('summaryPaymentDate')"],
      ['employee count', "tl('colEmployees')"],
    ] as const) {
      expect(SCREEN, `the reset screen does not state the ${fact}`).toContain(token);
    }
    // Read through the SAME projection the list renders, so the strip cannot disagree with the row.
    expect(SCREEN).toContain('const listed = (await listBatches(s, [batch.companyId], batch.payPeriod)).find');
    expect(SCREEN).toContain("const paymentDate = batch.batchDate ? dateFmt.format(new Date(`${batch.batchDate}T00:00:00Z`))");
  });

  it('the reason field survives the move, and the consequence is still explained', () => {
    expect(SCREEN).toMatch(/<form action=\{resetAction\}/);
    expect(SCREEN).toContain('<input type="hidden" name="batchId" value={batchId} />');
    expect(SCREEN).toMatch(/name="reason"/);
    expect(SCREEN).toContain("{t('resetDescription')}");
    expect(SCREEN).toContain("{t('resetCollectsOutstanding')}");
    expect(SCREEN).toContain("{t('resetConfirm')}");
  });

  it('the screen IS the confirmation — it does not open a second dialog of its own', () => {
    // Wrapping this page's submit in a ConfirmSubmit would put the operator back through a dialog for an
    // action whose whole confirmation is now the page they are standing on.
    expect(SCREEN, 'the reset screen grew its own confirmation dialog').not.toContain('ConfirmSubmit');
  });
});

describe('9f8cd608 · D — the reset rule did not move', () => {
  it('the visibility conditions stay on the list’s server page, written exactly as they were', () => {
    expect(LIST, 'Reset Payroll: processed + the reset risk switch').toMatch(
      /b\.status === 'processed' && resetOn && \(/,
    );
    expect(LIST, 'Reprocess: processed + multi-cycle').toMatch(/b\.status === 'processed' && multiCycleOn && \(/);
    expect(LIST, 'Remove Employee: processed + multi-cycle + the reset risk switch').toMatch(
      /b\.status === 'processed' && multiCycleOn && resetOn && \(/,
    );
  });

  it('the screen is a SECOND surface, never the authority', () => {
    // requireAdmin gates the door; the setting is re-read so a direct visit is told why rather than
    // discovering it by pressing a destructive button. What decides the reset is still the service.
    expect(SCREEN).toContain('const s = await requireAdmin();');
    expect(SCREEN).toContain("const resetOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');");
    expect(SCREEN).toContain("t('resetDisabled')");
    expect(SCREEN).toContain("t('resetOnlyProcessed')");
    expect(SCREEN, 'the screen started calling the engine directly').not.toContain('resetProcessedBatch');
  });
});

describe('9f8cd608 · E — the return path survives the extra hop', () => {
  it('list → screen → action: the filter query is carried, whitelisted, then posted on', () => {
    expect(LIST).toMatch(/href=\{`\/payroll\/\$\{b\.id\}\/reset\?from=\$\{fromQuery\}`\}/);
    expect(LIST).toContain('const fromQuery = encodeURIComponent(dashboardHref(filters));');
    // Whitelisted BY SHAPE at this end — a href out of searchParams is the open-redirect shape.
    expect(SCREEN).toContain("import { payrollListReturnTo } from '@/lib/return-to';");
    expect(SCREEN).toContain('const back = payrollListReturnTo(sp.from);');
    expect(SCREEN).toContain("const from = back === '/payroll' ? null : back;");
    expect(SCREEN).toContain('<input type="hidden" name="from" value={from} />');
  });

  it('Back and Cancel both return the list AS LEFT — leaving costs nothing either way', () => {
    expect(SCREEN).toContain("back={{ href: back, label: t('resetBack') }}");
    expect(SCREEN).toMatch(/<Link\s+href=\{back\}/);
  });
});

describe('9f8cd608 · F — the route is grantable, and the copy resolves', () => {
  it('the new guarded page has a screen column (reverse completeness)', () => {
    expect(REGISTERED_ROUTES.has('/payroll/[batchId]/reset')).toBe(true);
  });

  it.each([
    ['payroll.batch', 'resetBack'],
    ['payroll.batch', 'resetDisabled'],
    ['common', 'cancel'],
  ])('%s.%s exists in all six locales and takes no ICU argument', (ns, key) => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8'));
      const value = `${ns}.${key}`
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);
      expect(typeof value, `${loc} missing ${ns}.${key}`).toBe('string');
      expect((value as string).length, `${loc} blank ${ns}.${key}`).toBeGreaterThan(0);
      // Read through a bare t(); a message carrying `{…}` THROWS at render rather than degrading.
      expect(value as string, `${loc} ${ns}.${key} carries an ICU placeholder`).not.toMatch(/\{/);
    }
  });

  it('Cancel is read from the shared namespace, not a minted reset* twin of removeCancel', () => {
    // test/payroll-remove-i18n.test.ts forbids a remove* key sharing Reset's exact copy. A
    // `payroll.batch.resetCancel` reading "Cancel" would collide with `removeCancel`, and inventing a
    // different word for Cancel to dodge that would be the wrong way round — so the neutral button label
    // comes from `common`.
    expect(SCREEN).toContain("const tc = await getTranslations('common');");
    expect(SCREEN).toContain("{tc('cancel')}");
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));
    expect(en.payroll.batch.resetCancel, 'a reset* Cancel twin was minted after all').toBeUndefined();
  });
});

/**
 * G — THE PLAN'S LAST BULLET: "Confirm runs the reset, shows a success or error message, and returns you
 * to the refreshed list."
 *
 * Success was always right (`payrollListAfterReset` → the list, as left, minus a status filter that would
 * hide the new Draft run). The ERROR half was not: every refusal redirected to `/payroll/<batchId>` — the
 * long run screen 7076f8af was raised to get operators OFF — which threw away this screen, the message's
 * context and the filter query in one move. And it is reachable with no race at all: the reason box is
 * guarded only by HTML `required`, which a single space satisfies, so one space and Reset Payroll reaches
 * `ResetReasonRequiredError`.
 *
 * So a refusal now comes back HERE, exactly as the sibling Remove screen does — and while the refusals
 * were being counted, `SettingNotEnabledError` turned out to be unmapped: the first thing
 * `resetProcessedBatch` throws, falling through to `(e as Error).message` and painting the service's raw
 * English into the banner in all six locales. That is the identical hole test/payroll-remove-i18n.test.ts
 * was written to close for Remove.
 */
describe('9f8cd608 · G — a refusal returns to the screen, translated', () => {
  const ACTIONS = code('app/payroll/actions.ts');
  const RUN_SCREEN = code('app/payroll/[batchId]/page.tsx');
  /** The body of one exported function, up to the next top-level `export`. */
  const bodyOf = (src: string, decl: string) => {
    const from = src.indexOf(decl);
    expect(from, `${decl} not found — has it been renamed?`).toBeGreaterThan(-1);
    const rest = src.slice(from);
    const end = rest.indexOf('\nexport ', 1);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const RESET_ACTION = bodyOf(ACTIONS, 'export async function resetAction(');
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  /** `payroll.batch.resetDisabled` → the string in that locale, or undefined. */
  const message = (loc: string, dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8')),
      );

  it('every refusal resetProcessedBatch can raise has a translated line in resetAction', () => {
    // Derived from the SERVICE's own source (comments stripped, so prose about an error cannot satisfy
    // this), so a refusal added there without a line here fails immediately rather than reaching an
    // operator as untranslated English.
    const service = bodyOf(code('core/payroll.ts'), 'export async function resetProcessedBatch(');
    const thrown = [...new Set([...service.matchAll(/throw new ([A-Z]\w*)\(/g)].map((m) => m[1]))]
      .filter((n) => n !== 'Error') // the "batch not found" impossible state — not an operator outcome
      .sort();
    // A floor, so a refactor that stops matching cannot make this pass vacuously.
    expect(thrown.length, `derived too few: ${thrown.join(', ')}`).toBeGreaterThanOrEqual(3);
    const unmapped = thrown.filter((n) => !RESET_ACTION.includes(`instanceof ${n}`));
    expect(unmapped, `unmapped in resetAction: ${unmapped.join(', ')}`).toEqual([]);
    // The fourth one is thrown by a HELPER, not by a `throw new` the regex above can see, so it is named
    // rather than derived — the honest form of the same check.
    expect(service).toContain("assertPayrollPermission(tx, ctx, 'payroll.rollback'");
    expect(RESET_ACTION, 'the permission refusal lost its translated line').toContain(
      'instanceof PayrollPermissionDeniedError',
    );
  });

  it.each([
    ['resetDisabled', 'SettingNotEnabledError'],
    ['resetAdminOnly', 'PayrollPermissionDeniedError'],
    ['resetReasonRequired', 'ResetReasonRequiredError'],
    ['resetOnlyProcessed', 'BatchNotResettableError'],
  ])('payroll.batch.%s (for %s) resolves non-empty in all six locales', (key) => {
    expect(RESET_ACTION, `resetAction no longer renders ${key}`).toContain(`t('${key}')`);
    for (const loc of LOCALES) {
      const v = message(loc, `payroll.batch.${key}`);
      expect(typeof v, `${loc} missing payroll.batch.${key}`).toBe('string');
      expect((v as string).trim().length, `${loc} blank payroll.batch.${key}`).toBeGreaterThan(0);
    }
  });

  it('the screen posts the surface flag, and a refusal from it comes back to the screen', () => {
    expect(SCREEN, 'the reset screen stopped identifying itself to the action').toContain(
      '<input type="hidden" name="surface" value="reset-screen" />',
    );
    expect(RESET_ACTION).toContain("const onResetScreen = formData.get('surface') === 'reset-screen';");
    expect(RESET_ACTION, 'a refusal no longer returns to the reset screen').toContain(
      'redirect(`/payroll/${batchId}/reset?${q.toString()}`)',
    );
  });

  it('the run screen posts NO flag, so its own refusals still land on the run screen', () => {
    // The other caller of this action is unchanged, and must stay that way: on the run screen the run is
    // where the operator already is, and that is where the refusal belongs.
    const runResetForm = RUN_SCREEN.slice(
      RUN_SCREEN.indexOf('<form action={resetAction}>'),
      RUN_SCREEN.indexOf('</form>', RUN_SCREEN.indexOf('<form action={resetAction}>')),
    );
    expect(runResetForm.length, 'the run screen no longer posts resetAction').toBeGreaterThan(0);
    expect(runResetForm, 'the run screen started claiming to be the reset screen').not.toContain('surface');
    expect(RESET_ACTION, 'the run screen lost its own refusal destination').toContain(
      'redirect(`/payroll/${batchId}?error=${encodeURIComponent(msg)}`)',
    );
  });

  it('the refusal carries the filter query and the typed reason back with it', () => {
    // `from` is re-whitelisted BY SHAPE and NOT put through payrollListAfterReset: a refused reset leaves
    // the run processed, so the status filter the operator set must survive verbatim.
    expect(RESET_ACTION).toContain("const refusalFrom = payrollListReturnTo(formData.get('from'));");
    expect(RESET_ACTION).toContain("if (refusalFrom !== '/payroll') q.set('from', refusalFrom);");
    // Length-capped: this rides in a Location header, not a page body.
    expect(RESET_ACTION).toContain("if (reason && reason.length <= 500) q.set('reason', reason);");
    // …and the screen actually renders both halves.
    expect(SCREEN, 'the screen does not show the refusal it was sent').toContain('<ErrorBanner message={sp.error} />');
    expect(SCREEN, 'the refused reason is not put back in the box').toContain('defaultValue={sp.reason}');
    expect(SCREEN).toContain('searchParams: Promise<{ from?: string; error?: string; reason?: string }>;');
  });

  it('the payroll-cycle label is a DYNAMIC lookup, so every enum value it can take is checked', () => {
    // `tl(`runType.${batch.runType}`)` is a template key: test/i18n-coverage.test.ts skips it by
    // construction and test/payroll-remove-i18n.test.ts skips it too. Derived from the DB enum so a fifth
    // run type fails here rather than rendering MISSING_MESSAGE on a destructive confirmation screen.
    expect(SCREEN).toContain('tl(`runType.${batch.runType}`)');
    expect(payrollRunTypeEnum.enumValues.length, 'the run-type enum came back empty').toBeGreaterThanOrEqual(4);
    for (const rt of payrollRunTypeEnum.enumValues) {
      for (const loc of LOCALES) {
        const v = message(loc, `payroll.list.runType.${rt}`);
        expect(typeof v, `${loc} missing payroll.list.runType.${rt}`).toBe('string');
      }
    }
  });
});
