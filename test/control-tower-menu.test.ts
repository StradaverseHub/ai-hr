/**
 * ADR-0083 r233 — THE CONTROL TOWER IS ITS OWN SECTION, AND THE EXPLAINER TELLS THE TRUTH.
 *
 * Two things are guarded here and they fail in opposite directions.
 *
 * THE MOVE: a screen that changes menus is one bookmark away from a 404, and this one shipped live in
 * r229. The old href must keep resolving forever; the new one must be registered everywhere a guarded
 * route has to be (AGENTS 20), and it must not be left in BOTH menus, because two paths to one screen is
 * how a menu stops telling you where things live.
 *
 * THE EXPLAINER: it is a page whose entire value is that an admin can trust it. Its statuses must be READ
 * FROM THE SYSTEM rather than declared — a page that claims the narrator is on because a constant says so
 * manufactures confidence and is wrong precisely when it matters. And it must state what does NOT run:
 * autonomy is off, that is a decision (ADR-0083 §2.5), and an admin discovering it by accident is the
 * failure this page exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_DOMAINS, domainsFor } from '../core/control-domains';
import { DETECTORS } from '../core/payroll-anomaly-detectors';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('r233 — the move out of the Payroll menu', () => {
  it('the old href still RESOLVES, as a forward and not a 404', () => {
    // It shipped live in r229. A bookmark or a link in someone's notes must not break to tidy a menu.
    const old = read('app/payroll/control-tower/page.tsx');
    expect(old).toContain('redirect');
    expect(old).toContain('/control-tower');
    expect(fs.existsSync(path.join(ROOT, 'app/control-tower/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app/control-tower/how-it-works/page.tsx'))).toBe(true);
  });

  it('and the row is gone from the payroll menu — not duplicated into both', () => {
    expect(read('packs/payroll/index.ts')).not.toContain("href: '/payroll/control-tower'");
    expect(read('packs/payroll/phases.ts')).not.toContain("'/payroll/control-tower'");
  });

  it('the new section exists, is admin-gated, and is entitlement-gated', () => {
    const side = read('components/sidebar.tsx');
    expect(side).toContain("labelKey: 'aiControlTower'");
    expect(side).toContain("href: '/control-tower'");
    expect(side).toContain("href: '/control-tower/how-it-works'");
    // Without a MODULE_OF_HREF entry the rail advertises a module the tenant may not hold.
    expect(side).toContain("['/control-tower', 'payroll'] as const");
  });

  it('both guarded routes carry a function-access column, and the FORWARD does not', () => {
    // AGENTS 20 for the two real screens; the redirect has no guard of its own, and listing it would
    // claim a screen that does not exist.
    const perms = read('lib/permissions.ts');
    expect(perms).toContain("'/control-tower'");
    expect(perms).toContain("'/control-tower/how-it-works'");
    expect(perms).not.toContain("'/payroll/control-tower'");
  });
});

describe('ADR-0083 §2.2 — the tower reads a registry, not the word "payroll"', () => {
  it('payroll is one domain among several, and its check count is derived', () => {
    const payroll = CONTROL_DOMAINS.find((d) => d.id === 'payroll')!;
    expect(payroll.status).toBe('live');
    // Derived from the detector list, never hand-typed — a hand-typed count drifts the day one is added.
    expect(payroll.detectorCount).toBe(DETECTORS.length);
    expect(CONTROL_DOMAINS.length).toBeGreaterThan(1);
    expect(CONTROL_DOMAINS.filter((d) => d.status === 'planned').length).toBeGreaterThan(0);
  });

  it('a planned domain contributes no counts anywhere', () => {
    // They are listed so an operator can see the queue in front of them is one loop out of several. That
    // is only honest if they never inflate a number.
    for (const d of CONTROL_DOMAINS.filter((x) => x.status === 'planned')) {
      expect(d.detectorCount, `${d.id} is planned and must count nothing`).toBe(0);
    }
  });

  it('domainsFor drops a domain whose module the tenant does not hold', () => {
    // A REAL snapshot, not an approximation: isEntitlementSnapshot validates the whole shape at runtime
    // and fails CLOSED with a typed error, so a hand-waved object here tests the guard rather than the
    // filter. `payroll` is absent from enabledModules, which is the condition under test.
    const withoutPayroll = domainsFor({
      tenantId: 'x',
      roles: [],
      entitlements: {
        tenantId: 'x',
        enabledModules: [],
        scopedModules: {},
        settings: {},
        tenantStatus: 'active',
      },
    } as never);
    expect(withoutPayroll.map((d) => d.id)).not.toContain('payroll');
    // The module-free planned ones survive, which is what makes the "1 of 4" line honest for a tenant
    // that has not bought payroll.
    expect(withoutPayroll.length).toBeGreaterThan(0);
  });
});

describe('ADR-0083 — the explainer states what does NOT run', () => {
  const page = read('app/control-tower/how-it-works/page.tsx');
  const en = JSON.parse(read('messages/en.json')).controlTower as Record<string, Record<string, string> | string>;

  it('renders the autonomy row rather than omitting it', () => {
    // The row exists in the roster with offByDesign; the page must show `statusByDesign` rather than
    // treating it as an ordinary "off" or hiding it.
    expect(page).toContain('offByDesign');
    expect(page).toContain('statusByDesign');
    expect((en.agent as Record<string, string>).autonomy).toBeTruthy();
    expect((en.why as Record<string, string>).autonomyByDesign).toBeTruthy();
  });

  it('carries a reason for every status, never a bare flag', () => {
    // "Off" with no explanation is the one thing an operator cannot act on.
    expect(page).toContain('why.');
    for (const key of ['moduleOff', 'sweepNever', 'sweepStale', 'noProvider', 'assistantNoGrant']) {
      expect((en.why as Record<string, string>)[key], `why.${key}`).toBeTruthy();
    }
  });

  it('states both invariants in plain words', () => {
    // ADR-0074's invariant and ADR-0083 §2.5, said to the person who has to trust the queue.
    expect(String(en.promise1)).toMatch(/never/i);
    expect(String(en.promise1Body)).toMatch(/calculated|engine/i);
    expect(String(en.promise2)).toMatch(/never/i);
  });

  /**
   * r235 — THE GUARD THAT SHOULD HAVE EXISTED SINCE r233, ADDED WHEN A SIXTH AGENT ROW LANDED.
   *
   * The roster is data: the page renders `agent.${a.id}`, `agent.${a.id}Does` and `why.${a.reasonKey}`
   * as DYNAMIC keys, which `i18n-coverage`'s static-key case cannot see (it says so in its own header).
   * So an agent added to `agentStatuses` with a key missing from en.json throws MISSING_MESSAGE and
   * CRASHES the explainer — a 200-passing, tsc-clean, suite-green crash of exactly the class AGENTS 6
   * describes. This reads the ids and reason keys back out of the source, both branches of every ternary
   * included, so adding a row without its strings fails here instead of on the screen.
   */
  it('every roster row and every reason it can carry has a string in en.json', () => {
    const src = read('core/control-domains.ts');
    const body = src.slice(src.indexOf('export async function agentStatuses'));
    const agent = en.agent as Record<string, string>;
    const why = en.why as Record<string, string>;

    // ⚠️ `[A-Za-z_]` NOT `[a-z_]` (r238). The original class silently skipped every camelCase id, so the
    // four authoring assists added that round — `payRuleDrafter` and friends — would have gone
    // unguarded: exactly the MISSING_MESSAGE crash this case exists to prevent, hidden by the guard
    // itself. A character class in a source-scanning guard is part of its coverage, not a detail.
    const ids = [...body.matchAll(/^\s*id: '([A-Za-z_]+)',$/gm)].map((m) => m[1]!);
    // The roster is thirteen rows as of r240; a bare `toBeGreaterThan(0)` here would let a regex that
    // stopped matching pass silently, which is the vacuity this whole file guards against elsewhere.
    expect(ids.length, `ids found: ${ids.join(', ')}`).toBeGreaterThanOrEqual(13);
    for (const id of ids) {
      expect(agent[id], `controlTower.agent.${id}`).toBeTruthy();
      expect(agent[`${id}Does`], `controlTower.agent.${id}Does`).toBeTruthy();
    }

    // Every quoted string in a `reasonKey:` EXPRESSION — a ternary contributes every one of its
    // branches, and the branch that only appears when something is switched off is the one nobody
    // renders while testing.
    //
    // ⚠️ IT READS TO THE END OF THE EXPRESSION, NOT THE END OF THE LINE (r238). A four-way ternary is
    // wrapped by the formatter, so the line-bounded form here saw only the first branch and let three
    // reason keys through unguarded. The expression ends at the row's next property or at the row's
    // closing brace.
    const reasons = [...body.matchAll(/reasonKey:[\s\S]*?(?=\n\s{6}\w+:|\n\s{4}\},)/g)].flatMap((m) =>
      [...m[0].matchAll(/'([A-Za-z]+)'/g)].map((q) => q[1]!),
    );
    expect(reasons.length, `reasons found: ${reasons.join(', ')}`).toBeGreaterThanOrEqual(20);
    // ⚠️ EVERY quoted string in the expression is demanded as a reason key, INCLUDING one that is not a
    // reason at all. r240 briefly wrote `isModuleEnabled(ctx, 'claims')` inline in a reasonKey ternary and
    // this case then required a `why.claims` string the page never renders. The guard is right to be
    // blunt; the fix is to hoist a module check into a variable and keep the expression to reason keys.
    for (const key of reasons) expect(why[key], `controlTower.why.${key}`).toBeTruthy();
  });

  it('distinguishes the AI steps from the rules-only ones in the drawing', () => {
    // The legend is the point of the illustration: an operator should see at a glance which parts can be
    // creative and which cannot.
    expect(page).toContain('legendDeterministic');
    expect(page).toContain('legendLlm');
    expect(page).toContain('legendHuman');
    expect(page).toContain('aria-label');
  });
});
