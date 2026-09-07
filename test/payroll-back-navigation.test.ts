/**
 * 9066bd6c — BACK ON EVERY SCREEN BELOW PAYROLL PROCESS, and Back returns the list as it was left.
 *
 * THE MEASURED PREMISE, AND THE CORRECTION. The approved plan states "Seventeen of the thirty-five
 * payroll screens show a Back link and eighteen do not". Seventeen is what you count if you look for the
 * literal `back={{ href, label }}` object — which is what that measurement did. It MISSES the seven
 * Statutory Configuration pages, every one of which already passes `back={back}` from `settingsBack()`.
 * The real figure before this change was 24 of 35, and the screens genuinely without any Back were:
 *
 *   app/payroll/process/result           · app/payroll/individual-payslip
 *   app/payroll/transaction-view         · app/payroll/statutory-adjustment
 *   app/payroll/back-pay                 · app/payroll/statutory-forms
 *
 * plus `[batchId]/anomalies`, which HAD one — hand-rolled as a small <Link> above the header instead of
 * in PageHeader's own slot — and has been moved into the header rather than added.
 *
 * WHAT THIS FILE GUARDS, and why it is a SOURCE-SHAPE test rather than a render test: the defect lives in
 * the CONTRACT BETWEEN two files (the list writes `?from=…`, the destination reads it), and a unit test of
 * either half passes whatever the other half does. So both halves are asserted here, against the source.
 *
 *   A. Every page under app/payroll that renders PageHeader passes `back`, unless it is on the explicit
 *      allowlist of MODULE LANDING PAGES — the four screens that are Payroll flyout entries with no
 *      parent to go back to. The next screen added under app/payroll cannot quietly skip Back.
 *   B. The Payroll Process list hands its own filter query to every row link as `?from=…`.
 *   C. The screens that receive it resolve it through `payrollListReturnTo`, never raw.
 *   D. `payrollListReturnTo` itself: it keeps a real filter query and refuses every off-site shape.
 *
 * r253 adds the half every one of the cases above walks past, and it is where the reporter's complaint
 * actually lived: A-D are all about LINKS. The run flow's own BUTTONS — Close payroll, Generate, Unlock,
 * Reprocess and the four anomaly actions — redirected to hardcoded paths, so pressing any of them threw
 * the selection away and Back went to the current period.
 *
 *   C3. Every one of those actions builds its destination through `withPayrollFrom`, and no posted value
 *       reaches a redirect without it.
 *   D2. `withPayrollFrom` itself: encoded, joined correctly, and omitted entirely when there is nothing
 *       to carry or the value is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { payrollListReturnTo, withPayrollFrom } from '../lib/return-to';

const ROOT = path.resolve(__dirname, '..');
const PAYROLL = path.join(ROOT, 'app', 'payroll');

/**
 * The screens that legitimately have no Back, stated by path so adding one is a deliberate act.
 *
 * Each is a PAYROLL FLYOUT ENTRY (packs/payroll/index.ts navLinks) — a top-level destination in the
 * sidebar, not a screen below another one. A Back link on them would point at a parent that does not
 * exist. Note that five of their flyout siblings (back-pay, transaction-view, individual-payslip,
 * statutory-adjustment, statutory-forms) DO carry one: they are the screens an operator reaches while
 * working a payroll run, and the reporter's complaint was about exactly that journey.
 */
const NO_BACK_ALLOWLIST = new Set([
  'app/payroll/page.tsx',
  'app/payroll/reports/page.tsx',
  'app/payroll/setup/page.tsx',
  'app/payroll/transactions/page.tsx',
]);

function pagesRenderingPageHeader(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'page.tsx' && fs.readFileSync(p, 'utf8').includes('<PageHeader')) {
        out.push(path.relative(ROOT, p));
      }
    }
  };
  walk(PAYROLL);
  return out.sort();
}

describe('Payroll back navigation (source shape)', () => {
  it('A. every payroll page rendering PageHeader passes `back`, except the four module landing pages', () => {
    const pages = pagesRenderingPageHeader();
    // A sanity floor: if this collapses, the walk is broken and every case below is vacuously true.
    expect(pages.length).toBeGreaterThanOrEqual(30);
    const missing = pages.filter(
      (rel) => !NO_BACK_ALLOWLIST.has(rel) && !fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('back={'),
    );
    expect(missing, `payroll pages rendering PageHeader with no back link:\n${missing.join('\n')}`).toEqual([]);
  });

  it('A2. the allowlist names only pages that exist and really do render PageHeader', () => {
    // Otherwise a renamed or deleted screen would leave a permanent hole in case A.
    const pages = new Set(pagesRenderingPageHeader());
    for (const rel of NO_BACK_ALLOWLIST) {
      expect(pages.has(rel), `${rel} is allowlisted but no longer renders PageHeader`).toBe(true);
    }
  });

  it('B. the Payroll Process list hands its own filter query to EVERY link that leaves the row', () => {
    const src = fs.readFileSync(path.join(PAYROLL, 'page.tsx'), 'utf8');
    // The one serialiser of a filter selection — reused, not rebuilt.
    expect(src).toContain('const fromQuery = encodeURIComponent(dashboardHref(filters));');
    for (const href of [
      'href={`/payroll/${b.id}?from=${fromQuery}`}',
      'href={`/payroll/${b.id}/reprocess?from=${fromQuery}`}',
      'href={`/payroll/${b.id}/remove?from=${fromQuery}`}',
      // d75b0c11 — Reset was ALREADY built this way (9f8cd608 made it a link) and was simply missing
      // from this list, so the one row action nobody was guarding was the destructive one.
      'href={`/payroll/${b.id}/reset?from=${fromQuery}`}',
      // …and the three links this case did not cover at all, all added by d75b0c11. `resumeHref` serves
      // BOTH the period cell (the most natural way into a run — you click the run) and Continue on a
      // draft; the New-run button opens the wizard, whose Back is now the list as it was left.
      'href={`/payroll/process?from=${fromQuery}`}',
    ]) {
      expect(src, `row link missing the filter query: ${href}`).toContain(href);
    }
    // Two call sites, both passing it — a bare `resumeHref(b.id, b.status)` left anywhere on this screen
    // is a link that silently drops the selection.
    expect(src.match(/resumeHref\(b\.id, b\.status, fromQuery\)/g) ?? []).toHaveLength(2);
    expect(src, 'a resumeHref call is still dropping the filter query').not.toMatch(
      /resumeHref\(b\.id, b\.status\)/,
    );
  });

  it('C. the screens that receive `?from=` resolve it through payrollListReturnTo, never raw', () => {
    for (const rel of [
      'app/payroll/[batchId]/page.tsx',
      'app/payroll/[batchId]/reprocess/page.tsx',
      'app/payroll/[batchId]/remove/page.tsx',
      'app/payroll/[batchId]/reset/page.tsx',
      // d75b0c11 — Anomalies sends Back to the RUN, and hands the run its own `?from=` back so the
      // chain is unbroken a screen deeper than 9066bd6c reached.
      'app/payroll/[batchId]/anomalies/page.tsx',
      // …and the wizard + its terminal Result screen, both through the shared helper below.
      'app/payroll/back.ts',
      'app/payroll/process/actions.ts',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel} must whitelist ?from= by shape`).toContain('payrollListReturnTo');
      // The open-redirect shape this exists to prevent: a href taken straight out of searchParams.
      expect(src, `${rel} must not put a raw searchParams value in a back href`).not.toContain(
        "back={{ href: sp.from",
      );
    }
  });

  it('C2. the screens whose Back is the Payroll Process list build it with payrollProcessBack', () => {
    /**
     * d75b0c11 extends the 9066bd6c set by two: the Payroll Process WIZARD (reached from the New-run
     * button and from Continue on a draft row, and previously pinned to a literal `/payroll`), and the
     * wizard's terminal Result screen — which has read `?from=` since 9066bd6c and never received one,
     * because a redirect is the only way onto it and neither run action carried the value.
     *
     * The helper is the subject rather than the href because it is also where the SINGLE next-intl
     * namespace lives (app/payroll/back.ts): a page that inlined `getTranslations('payroll.list')`
     * alongside its own namespace would silently switch off test/i18n-coverage.test.ts Check C for
     * itself, which only statically resolves single-namespace files.
     */
    for (const rel of [
      'app/payroll/back-pay/page.tsx',
      'app/payroll/individual-payslip/page.tsx',
      'app/payroll/statutory-adjustment/page.tsx',
      'app/payroll/statutory-forms/page.tsx',
      'app/payroll/transaction-view/page.tsx',
      'app/payroll/process/page.tsx',
      'app/payroll/process/result/page.tsx',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel} must build Back through payrollProcessBack`).toContain('payrollProcessBack');
    }
    // And the actions that redirect onto the Result screen must actually put a `from` on it — the half
    // that was missing for the whole of 9066bd6c's life, and that no test of either file could see.
    const actions = fs.readFileSync(path.join(PAYROLL, 'process', 'actions.ts'), 'utf8');
    expect(actions.match(/resultFromSuffix\(formData\.get\('from'\)\)/g) ?? [],
      'both run actions must carry the selection onto /payroll/process/result').toHaveLength(2);
  });

  it('C3. the run-flow ACTIONS carry the posted selection onto their redirect, whitelisted not echoed', () => {
    /**
     * r253 — THE HALF NEITHER 9066bd6c NOR d75b0c11 LOOKED AT. Cases B and C above walk LINKS; this one
     * walks the BUTTONS. Every action here redirects to a screen whose Back reads `?from=`, and every
     * one of them used to redirect to a hardcoded path — so Close payroll (the reporter's own path),
     * Generate, Unlock, Reprocess and the four anomaly buttons all silently reset the operator's filter
     * selection to the current period, on a branch whose summary said the item already worked.
     *
     * COMMENTS STRIPPED (rule 27): the source explains this fix in prose that names the very helper the
     * guard looks for, so an unstripped read would pass on a file where the code had been ripped out.
     */
    const actions = fs
      .readFileSync(path.join(PAYROLL, 'actions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const bodyOf = (fn: string) => {
      const start = actions.indexOf(`export async function ${fn}(`);
      expect(start, `${fn} is gone from app/payroll/actions.ts`).toBeGreaterThan(-1);
      const next = actions.indexOf('export async function ', start + 10);
      return actions.slice(start, next === -1 ? undefined : next);
    };
    for (const fn of [
      'generateAction',
      'closeAction',
      'unlockAction',
      'reprocessSelectedAction',
      'evaluateAnomaliesAction',
      'narrateAnomalyAction',
      'proposeHypothesesAction',
      'resolveAnomalyAction',
    ]) {
      expect(bodyOf(fn), `${fn} builds its destination without the ?from= whitelist`).toContain(
        'withPayrollFrom(',
      );
    }
    // …and the posted value never reaches a redirect without passing through it. `removeEmployeePayroll`
    // and `resetAction` resolve theirs through the sibling helpers, which is why they are not listed.
    expect(actions, 'a raw posted `from` reached a redirect').not.toMatch(
      /redirect\([^;]*formData\.get\('from'\)/,
    );
  });

  it('D. payrollListReturnTo keeps a real filter query and refuses every off-site shape', () => {
    // Kept, verbatim — this is the whole point of the parameter.
    expect(payrollListReturnTo('/payroll?year=2026&m=5&m=6&company=abc&status=processed')).toBe(
      '/payroll?year=2026&m=5&m=6&company=abc&status=processed',
    );
    expect(payrollListReturnTo('/payroll')).toBe('/payroll');
    expect(payrollListReturnTo('/payroll/transactions?batchId=x')).toBe('/payroll/transactions?batchId=x');
    // A toast/error round-tripped from a previous redirect would double when the caller appends its own.
    expect(payrollListReturnTo('/payroll?year=2026&toast=done&error=nope')).toBe('/payroll?year=2026');

    // Refused — every one of these falls back to the plain list, which is the pre-change behaviour.
    for (const hostile of [
      'https://evil.example/payroll',
      '//evil.example/payroll',
      '/payrollevil.example',
      '/admin/users',
      'javascript:alert(1)',
      '',
      undefined,
      null,
      42,
      { href: '/payroll' },
      // The route's OWN legacy value: `?from=process` used to mark "arrived from the wizard". Nothing
      // has read it since 7076f8af, and it must degrade to today's destination rather than 404.
      'process',
    ]) {
      expect(payrollListReturnTo(hostile as unknown), `${String(hostile)} must not survive`).toBe('/payroll');
    }
  });

  it('D2. withPayrollFrom hangs a whitelisted selection on a destination, ENCODED, or nothing at all', () => {
    // r253 — the one idiom every action redirect now uses. Three properties, and the middle one is the
    // trap this whole item was raised over.
    const sel = '/payroll?year=2026&m=1&m=2&company=abc';
    // 1. ENCODED, so the carried query's own `&m=2` cannot become a parameter of the OUTER address.
    const hung = withPayrollFrom('/payroll/b1', sel);
    expect(hung).toBe(`/payroll/b1?from=${encodeURIComponent(sel)}`);
    expect(new URL(hung, 'https://app.test').searchParams.get('from')).toBe(sel);
    expect(new URL(hung, 'https://app.test').searchParams.getAll('m'), '`m` leaked out of from=').toEqual([]);
    // 2. Joined with `&` when the destination already carries a query of its own.
    expect(withPayrollFrom('/payroll/b1/reprocess?job=7', sel)).toBe(
      `/payroll/b1/reprocess?job=7&from=${encodeURIComponent(sel)}`,
    );
    // 3. OMITTED when there is nothing to carry or the value is refused — byte-identical to the address
    //    these actions redirected to before, which is what keeps the sidebar's own default untouched.
    for (const nothing of ['/payroll', '', undefined, null, 42, 'https://evil.example/payroll', '//evil.example', '/admin']) {
      expect(withPayrollFrom('/payroll/b1', nothing as unknown), `${String(nothing)} must not survive`).toBe(
        '/payroll/b1',
      );
    }
    // A round-tripped toast/error is stripped rather than doubled, exactly as case D pins for the href.
    expect(withPayrollFrom('/payroll/b1', '/payroll?year=2026&toast=done')).toBe(
      `/payroll/b1?from=${encodeURIComponent('/payroll?year=2026')}`,
    );
  });
});
