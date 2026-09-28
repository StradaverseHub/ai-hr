/**
 * ══ 0df7dd44 (r352) — TP1 RELIEF: THE ANNUAL-LIMIT REFUSAL STAYS ON THE FORM ════════════════════════
 *
 * THE REPORT: "when the keyed amount exceeds the annual limit, the system directly redirects the user back
 * to the TP1 Relief screen. This is not user-friendly because the user does not receive a clear
 * explanation of why the entry was rejected."
 *
 * THE FAULT WAS NOT A MISSING MESSAGE. `core/tax-relief.ts` has named the limit, the accumulated figure
 * and the shortfall since r209, and the form page has had a working `<ErrorBanner>` since 7ad37961. What
 * was wrong is that every write action `redirect()`ED TO A DIFFERENT SCREEN — the TP1 Relief LIST — so the
 * banner was drawn somewhere the reader was no longer filling anything in, and the form's forty-odd
 * uncontrolled amount boxes were unmounted with everything in them.
 *
 * ⚠️ WHY THIS FILE EXISTS RATHER THAN A CASE ADDED TO test/tp1-2026-form.test.ts. Every refusal test in
 * this repo asserted at SERVICE level with `rejects.toThrow`, which is exactly the shape that stayed green
 * through the reported defect: the service refused correctly all along. Nothing anywhere asserted what the
 * SCREEN did with that refusal. These are the cases that would have failed before the fix.
 *
 * ⚠️ AND THE LOAD-BEARING ASSERTION IS THE CLAMP TARGET, `limit − already` AND NEVER `limit`. The fixture
 * therefore has a PRIOR APPROVED CLAIM, so the two figures DIFFER (C5: limit 2,500, already 1,800,
 * remaining 700). A fixture with no prior claim would make `limit` and `remaining` the same number and
 * every assertion below would pass against a version that silently over-claims for every employee who has
 * claimed once already this year. The browser half of the same claim is in test/r352-tp1-limit.dom.test.tsx.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const { session } = vi.hoisted(() => ({ session: { s: null as unknown } }));
const { locale } = vi.hoisted(() => ({ locale: { value: 'en' } }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
// redirect() is a SPY THAT DOES NOTHING, which is the whole instrument here: "no redirect occurs" is only
// checkable if the call would have been recorded. In Next it throws; a no-op lets the action run to its
// return so this file can assert BOTH that nothing navigated and what came back instead.
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => undefined),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
/**
 * `getTranslations` resolved against the REAL message catalogue of the locale under test, with plain
 * `{param}` substitution.
 *
 * NOT `(k) => k`, which is what the other screen tests use. A stub that returns the key proves the code
 * reached a catalogue and nothing else: a message with a missing `{remaining}` placeholder, or a key that
 * exists in en.json and nowhere else, would sail straight through it. The refusal being TRANSLATED AND
 * COMPLETE in six locales is half of what this item asked for, so it is resolved for real.
 */
vi.mock('next-intl/server', () => ({
  getLocale: vi.fn(async () => locale.value),
  getTranslations: vi.fn(async (ns: string) => {
    const dict = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${locale.value}.json`), 'utf8'),
    );
    const node = ns.split('.').reduce<any>((o, k) => o?.[k], dict);
    return (key: string, params?: Record<string, unknown>) => {
      const raw = key.split('.').reduce<any>((o, k) => o?.[k], node);
      if (typeof raw !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key} (${locale.value})`);
      return raw.replace(/\{(\w+)\}/g, (m, p) => {
        if (params == null || !(p in params)) throw new Error(`MISSING_PARAM: ${ns}.${key}.${p}`);
        return String(params[p]);
      });
    };
  }),
}));
// Only `requireAdmin` is stubbed — the action's own door. `isAdmin` stays REAL, because core/tax-relief's
// `requireAdminTarget` calls it and replacing the module wholesale would swap that gate for a stub and
// this file would stop proving that an admin context is what reaches it.
vi.mock('@/lib/authz', async (orig) => {
  const actual = await orig<typeof import('../lib/authz')>();
  return { ...actual, requireAdmin: vi.fn(async () => session.s) };
});

import { redirect } from 'next/navigation';
import { hireEmployee } from '../core/org';
import {
  approveTp1ForPerson,
  getTp1AccumulatedForPerson,
  saveTp1DraftForPerson,
  submitTp1ForPerson,
  TaxReliefError,
  Tp1LimitError,
} from '../core/tax-relief';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { adminTp1FormAction } from '../app/payroll/transactions/deductions-actions';

const YEAR = 2026;
const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** C5 — lifestyle. Group limit 2,500 with four lettered lines and no printed sub-limits. */
const C5_LIMIT = 2500;
const C5_PRIOR = 1800;
/** What is left, and the ONLY figure the screen may clamp to. 700, not 2,500. */
const C5_REMAINING = C5_LIMIT - C5_PRIOR;

describe('0df7dd44 · the TP1 annual-limit refusal', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    session.s = adminCtx(base);
    locale.value = 'en';
    vi.mocked(redirect).mockClear();
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (name: string, email: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  /**
   * ONE EMPLOYEE WITH A PRIOR APPROVED CLAIM. January's RM1,800 of C5's RM2,500 is APPROVED, so February
   * has RM700 left — and `limit` and `remaining` are different numbers for every assertion below.
   */
  async function withPriorClaim(name: string, email: string) {
    const admin = adminCtx(base);
    const e = await hire(name, email);
    const { id } = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      declarationAccepted: true,
      categories: { form: 'tp1-2026', items: { c5: { subItems: { a: C5_PRIOR } } }, rebates: {} },
    });
    await approveTp1ForPerson(admin, {
      personId: e.personId,
      id,
      approvedMonth: 1,
      approvedYear: YEAR,
    });
    // The premise, proved rather than assumed: February's accumulation really is the prior claim.
    const acc = await getTp1AccumulatedForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 2,
    });
    expect(acc.items.c5, 'the fixture must leave `limit` and `remaining` different').toBe(C5_PRIOR);
    return e;
  }

  /** The FormData the shared form posts — the same field names `lib/tp1-form-input.ts` reads. */
  const formData = (p: {
    employmentId: string;
    intent: string;
    month: number;
    c5a?: number;
    c1c?: number;
  }) => {
    const fd = new FormData();
    fd.set('employmentId', p.employmentId);
    fd.set('intent', p.intent);
    fd.set('assessmentYear', String(YEAR));
    fd.set('tp1Form', 'tp1-2026');
    fd.set('deductionMonth', String(p.month));
    fd.set('declarationAccepted', 'yes');
    if (p.c5a != null) fd.set('tp1_items_c5_sub_a', String(p.c5a));
    if (p.c1c != null) fd.set('tp1_items_c1_sub_c', String(p.c1c));
    return fd;
  };

  // ═══════════════ A. the refusal comes back to the form, and nothing navigates ═══════════════

  it('SUBMIT over the remaining amount returns a message and does NOT redirect', async () => {
    const e = await withPriorClaim('Over Submit', 'oversubmit@acme.test');
    // 900 against 700 remaining: inside the RM2,500 annual limit, past what is left of it.
    const state = await adminTp1FormAction(
      { error: null },
      formData({ employmentId: e.employmentId, intent: 'submit', month: 2, c5a: 900 }),
    );
    expect(state.error, 'the refusal never reached the form').toBeTruthy();
    // ⚠️ THE REPORTED FAULT, PINNED. Before r352 this call ended in redirect('/payroll/transactions/tp1?…
    // &error=…') — the LIST — and the form was unmounted with every keyed box in it.
    expect(vi.mocked(redirect), 'the refusal navigated away from the form again').not.toHaveBeenCalled();
  });

  it('SAVE DRAFT over the remaining amount returns a message and does NOT redirect', async () => {
    const e = await withPriorClaim('Over Draft', 'overdraft@acme.test');
    const state = await adminTp1FormAction(
      { error: null },
      formData({ employmentId: e.employmentId, intent: 'draft', month: 2, c5a: 900 }),
    );
    expect(state.error, 'the draft refusal never reached the form').toBeTruthy();
    expect(vi.mocked(redirect)).not.toHaveBeenCalled();
  });

  it('SUBMIT AND APPROVE over the remaining amount returns a message and does NOT redirect', async () => {
    const e = await withPriorClaim('Over Both', 'overboth@acme.test');
    const state = await adminTp1FormAction(
      { error: null },
      formData({ employmentId: e.employmentId, intent: 'submitApprove', month: 2, c5a: 900 }),
    );
    expect(state.error, 'the one-press refusal never reached the form').toBeTruthy();
    expect(vi.mocked(redirect)).not.toHaveBeenCalled();
  });

  it('a claim that FITS still redirects with its toast, exactly as it always did', async () => {
    const e = await withPriorClaim('Fits', 'fits@acme.test');
    // 700 exactly fills what is left. Success behaviour is unchanged by this item.
    await adminTp1FormAction(
      { error: null },
      formData({ employmentId: e.employmentId, intent: 'submit', month: 2, c5a: C5_REMAINING }),
    );
    const to = String(vi.mocked(redirect).mock.calls.at(-1)?.[0] ?? '');
    expect(to, 'a successful submit stopped redirecting').toContain('/payroll/transactions/tp1?');
    expect(to, 'a success carried an error instead of a toast').toContain('toast=');
    expect(to).not.toContain('error=');
  });

  // ═══════════════ B. the message names the four figures, in the reader's language ═══════════════

  /**
   * ⚠️ NON-VACUITY LIVES HERE AS WELL AS IN THE DOM FILE. The message must name RM 700.00 — what is LEFT.
   * A version that reported the limit instead would print RM 2,500.00 and this fails, which is the same
   * switch the clamp test forbids.
   */
  it('names the limit, what is already approved, and what REMAINS — not the limit twice', async () => {
    const e = await withPriorClaim('Explains', 'explains@acme.test');
    const { error } = await adminTp1FormAction(
      { error: null },
      formData({ employmentId: e.employmentId, intent: 'submit', month: 2, c5a: 900 }),
    );
    expect(error).toContain('C5');
    expect(error, 'the annual limit is not named').toContain('2,500.00');
    expect(error, 'what is already approved this year is not named').toContain('1,800.00');
    expect(error, 'what REMAINS is not named — the reader cannot act on this').toContain('700.00');
    // 900 + 1,800 − 2,500 = 200. The shortfall was named before this round and must stay named.
    expect(error, 'the shortfall is not named').toContain('200.00');
  });

  it('is translated in all six locales, and the six are DISTINCT', async () => {
    const e = await withPriorClaim('Six', 'six@acme.test');
    const seen = new Map<string, string>();
    for (const loc of LOCALES) {
      locale.value = loc;
      const { error } = await adminTp1FormAction(
        { error: null },
        formData({ employmentId: e.employmentId, intent: 'submit', month: 2, c5a: 900 }),
      );
      expect(error, `${loc} produced no message`).toBeTruthy();
      // Every figure is interpolated from the pack, so the ringgit numbers appear in every locale.
      expect(error, `${loc} lost the remaining figure`).toContain('700.00');
      seen.set(loc, error!);
    }
    // ⚠️ PRESENCE IS NOT TRANSLATION. `i18n/request.ts` deep-merges each locale over English, so a key
    // missing from ms.json renders the ENGLISH sentence and never a MISSING_MESSAGE. Six identical
    // strings would be six English screens passing a test that only asked whether something rendered.
    expect(new Set(seen.values()).size, `six locales, ${new Set(seen.values()).size} distinct sentences`).toBe(6);
  });

  it('every locale carries the whole limit namespace, and none of them states a ringgit figure', () => {
    for (const loc of LOCALES) {
      const m = JSON.parse(read(path.join('messages', `${loc}.json`)));
      const limit = m.taxRelief?.limit;
      expect(limit, `${loc} has no taxRelief.limit`).toBeTruthy();
      expect(Object.keys(limit).sort()).toEqual([
        'annualRemaining',
        'clampedItem',
        'clampedLine',
        'itemLimit',
        'lineLimit',
      ]);
      // THE FIGURES MOVE IN ONE PLACE — the country pack. A statutory number written into six catalogues
      // is six copies that do not move when the Budget does, which is the mistake the legacy
      // "RM 9,000" help text made. Same rule test/tp1-2026-form.test.ts applies to the item labels.
      const prose = JSON.stringify([limit, m.taxRelief.sectionCHelp]);
      expect(prose.match(/RM\s?[\d,]+/g) ?? [], `${loc} restates a statutory limit in prose`).toEqual([]);
    }
  });

  // ═══════════════ C. the year-to-date check now runs on a DRAFT too ═══════════════

  /**
   * Requirement 5 of the approved plan. Before r352 `saveTp1DraftForPerson` checked THIS claim on its own
   * and never the year, so a draft saved clean and then refused on submit with a figure the reader had
   * already been told was fine.
   */
  it('a DRAFT over the remaining amount is refused at the service, as a submit is', async () => {
    const admin = adminCtx(base);
    const e = await withPriorClaim('Draft Ytd', 'draftytd@acme.test');
    const over = {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 2,
      categories: { form: 'tp1-2026', items: { c5: { subItems: { a: 900 } } }, rebates: {} },
    };
    await expect(saveTp1DraftForPerson(admin, over)).rejects.toThrow(Tp1LimitError);
    // …and what fits still saves, so this is a limit check and not a blanket refusal.
    await expect(
      saveTp1DraftForPerson(admin, {
        ...over,
        categories: { form: 'tp1-2026', items: { c5: { subItems: { a: C5_REMAINING } } }, rebates: {} },
      }),
    ).resolves.toBeTruthy();
  });

  // ═══════════════ D. the kernel states the refusal as data, with `remaining` = limit − already ═══════

  it('the breach carries limit − already, and that is NOT the limit', async () => {
    const admin = adminCtx(base);
    const e = await withPriorClaim('Breach', 'breach@acme.test');
    const err = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 2,
      declarationAccepted: true,
      categories: { form: 'tp1-2026', items: { c5: { subItems: { a: 900 } } }, rebates: {} },
    }).then(
      () => null,
      (e2) => e2,
    );
    expect(err, 'the over-claim was accepted').toBeInstanceOf(Tp1LimitError);
    // Still a TaxReliefError, so no existing caller or refusal test changes behaviour.
    expect(err).toBeInstanceOf(TaxReliefError);
    const b = (err as Tp1LimitError).breach;
    expect(b.code).toBe('annualRemaining');
    expect(b.label).toBe('C5');
    expect(b.item).toBe('c5');
    expect(b.limit).toBe(C5_LIMIT);
    expect(b.already).toBe(C5_PRIOR);
    // ⚠️ THE ONE ASSERTION THIS WHOLE ITEM TURNS ON.
    expect(b.remaining, 'the breach reports the LIMIT as claimable — this over-claims').toBe(C5_REMAINING);
    expect(b.remaining).not.toBe(b.limit);
  });

  it("a sub-line's own printed cap is reported against the sub-line, not the item", async () => {
    const admin = adminCtx(base);
    const e = await hire('Sub Cap', 'subcap@acme.test');
    // C1 group limit 8,000; sub-line (c) is limited to 1,000 on the form. 1,200 is inside the group.
    const err = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      declarationAccepted: true,
      categories: { form: 'tp1-2026', items: { c1: { subItems: { c: 1200 } } }, rebates: {} },
    }).then(
      () => null,
      (e2) => e2,
    );
    expect(err).toBeInstanceOf(Tp1LimitError);
    const b = (err as Tp1LimitError).breach;
    expect(b.code).toBe('lineLimit');
    expect(b.label).toBe('C1(c)');
    expect(b.item).toBe('c1');
    expect(b.sub).toBe('c');
    expect(b.limit).toBe(1000);
    // This check sees ONE claim, so it must not pretend to know the year.
    expect(b.already, 'a this-claim-only check claimed to know the year').toBeNull();
  });

  it('leaves an item the form prints no limit against alone (ADR-0008)', async () => {
    const admin = adminCtx(base);
    const e = await hire('No Limit', 'nolimit352@acme.test');
    // Section D's rebate lines carry no printed figure. Nothing here may invent one — not the service,
    // and not the screen, which is why the island passes a null ceiling for them.
    await expect(
      saveTp1DraftForPerson(admin, {
        personId: e.personId,
        assessmentYear: YEAR,
        deductionMonth: 3,
        categories: { form: 'tp1-2026', items: {}, rebates: { d1: { subItems: { a: 99_999 } } } },
      }),
    ).resolves.toBeTruthy();
  });

  // ═══════════════ E. the redirect-on-refusal spelling is gone from the paths that key amounts ═══════

  it('no amount-carrying TP1 action redirects on refusal any more', () => {
    const admin = read('app/payroll/transactions/deductions-actions.ts');
    const me = read('app/me/actions.ts');

    const formAction = admin.slice(
      admin.indexOf('export async function adminTp1FormAction'),
      admin.indexOf('// ── Section F — employer consent'),
    );
    expect(formAction, 'the one editable-form action is gone').toBeTruthy();
    // Every catch in the editable path hands the message BACK. A `backToTp1(…error=` in here is the
    // reported defect returning.
    expect(formAction, 'a refusal redirects again instead of returning to the form').not.toContain('error=');
    expect(formAction).toContain('return { error: await tp1RefusalMessage(e) };');

    const myAction = me.slice(me.indexOf('export async function myTp1FormAction'));
    expect(myAction.slice(0, 1400), 'the employee surface redirects on refusal again').not.toContain('error=');
    expect(myAction).toContain('return { error: await tp1RefusalMessage(e) };');

    // BOTH SURFACES, ONE TRANSLATOR. The same refusal worded two ways on two screens is how a reader
    // learns to trust neither — and /me renders the very same component through the very same reader.
    for (const [name, src] of [
      ['the HR action', admin],
      ['the employee action', me],
    ] as const) {
      expect(src, `${name} does not use the shared refusal translator`).toContain(
        "from '@/lib/tp1-refusal'",
      );
    }
  });
});
