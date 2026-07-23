/**
 * SKBBK Configuration tab (674ff6a5 — "Add SKBBK Tab to Statutory Configuration").
 *
 * SKBBK (Lindung 24 Jam, eff 1 Jun 2026) is an employee-paid leg carried ON the SOCSO bands
 * (`SocsoBand = ContribBand & { skbbk }`, inside `StatutoryRuleset.socso.category1/category2`). This item
 * surfaces it in its OWN tab under Payroll > Configuration WITHOUT introducing a new data store: the tab
 * reads the skbbk column from the active ruleset (read-only summary), and its Advanced edit reuses the
 * SOCSO slice of the shared `StatutoryConfigForm` so an edit round-trips the skbbk amounts back into the
 * SOCSO override.
 *
 * These are DB-free guards (static-source + the pure assemble/initState property), mirroring
 * `statutory-my-layout.test.ts` + `statutory-band-form-roundtrip.test.ts`. They fail loudly if a future
 * edit (a) drops the tab, (b) stops rendering the SKBBK rate column, (c) makes SKBBK an independently
 * versioned body (the NOT-chosen alternative), (d) breaks the SKBBK round-trip into the SOCSO override, or
 * (e) leaves the route unguarded or an i18n key missing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MY_STATUTORY,
  MY_EPF_THIRD_SCHEDULE_PART_A,
  MY_EPF_THIRD_SCHEDULE_PART_E,
  STATUTORY_BODIES,
  type StatutoryRuleset,
} from '../localization/my/statutory-tables';
import { assemble, initState } from '../components/statutory-config-form';

// Rung 5b (ADR-0080 D6): the form takes the pack's built-in EPF Third Schedule tables as an argument
// (threaded from pack.payroll.epfThirdSchedule by the server page); pass the same tables here.
const EPF_FALLBACK = { partA: MY_EPF_THIRD_SCHEDULE_PART_A, partE: MY_EPF_THIRD_SCHEDULE_PART_E };

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const I18N_KEYS = ['body_skbbk', 'skbbkDesc', 'skbbkAbout', 'secSkbbk', 'skbbkBothCategories', 'skbbkEditNote'] as const;

describe('SKBBK tab: registered alongside the other statutory tabs', () => {
  const tabs = read('components/statutory-tabs.tsx');

  it('adds a skbbk tab entry pointing at /payroll/configuration/skbbk', () => {
    expect(tabs).toMatch(/key:\s*'skbbk'/);
    expect(tabs.includes("href: '/payroll/configuration/skbbk'")).toBe(true);
    expect(tabs.includes("t('body_skbbk')")).toBe(true);
  });

  it("adds 'skbbk' to the StatutoryTabs active union so the tab can be marked active", () => {
    expect(tabs).toMatch(/active:\s*'overview'[^;]*'skbbk'/);
  });

  it('places SKBBK next to SOCSO (it rides on the SOCSO bands)', () => {
    expect(tabs.indexOf("key: 'socso'")).toBeLessThan(tabs.indexOf("key: 'skbbk'"));
    expect(tabs.indexOf("key: 'skbbk'")).toBeLessThan(tabs.indexOf("key: 'eis'"));
  });
});

describe('SKBBK page: read-only rate table + SOCSO-scoped Advanced edit', () => {
  const page = read('app/payroll/configuration/skbbk/page.tsx');

  it('reads the active ruleset (no new store) and renders the SKBBK column from the SOCSO bands', () => {
    expect(page.includes('pack.statutoryConfig.readActive(s)')).toBe(true);
    expect(page.includes('ruleset.socso.category1')).toBe(true);
    expect(page.includes('b.skbbk')).toBe(true);
    expect(page.includes("t('colSkbbkRm')")).toBe(true);
  });

  it('marks the skbbk tab active and stays under requireAdmin', () => {
    expect(page.includes('<StatutoryTabs active="skbbk" />')).toBe(true);
    expect(page.includes('requireAdmin()')).toBe(true);
  });

  it("Advanced edit reuses the SOCSO slice of the shared form (round-trips skbbk into the SOCSO override)", () => {
    expect(page.includes("sections={['socso']}")).toBe(true);
    expect(page.includes('StatutoryConfigForm')).toBe(true);
    // Save returns to the skbbk tab; the DomainEvent is appended by statutoryConfig.save (substrate).
    expect(page.includes('returnTo={SELF}')).toBe(true);
  });
});

describe('SKBBK is NOT an independently-versioned statutory body (the un-chosen alternative)', () => {
  it("STATUTORY_BODIES does not contain 'skbbk' — its version rides on SOCSO", () => {
    expect((STATUTORY_BODIES as readonly string[]).includes('skbbk')).toBe(false);
  });
});

describe('Advanced edit round-trips the SKBBK leg into the SOCSO override (byte-identical)', () => {
  // assemble(initState(DEFAULT)) is the pure "open the SOCSO editor, change nothing, publish" payload.
  const out = assemble(
    initState(DEFAULT_MY_STATUTORY, EPF_FALLBACK),
    DEFAULT_MY_STATUTORY,
    EPF_FALLBACK,
  ) as StatutoryRuleset;

  it('preserves the exact SKBBK amounts on Category 1 (the field most likely to be dropped)', () => {
    expect(out.socso.category1.map((band) => band.skbbk)).toEqual(
      DEFAULT_MY_STATUTORY.socso.category1.map((band) => band.skbbk),
    );
  });

  it('preserves the exact SKBBK amounts on Category 2', () => {
    expect(out.socso.category2.map((band) => band.skbbk)).toEqual(
      DEFAULT_MY_STATUTORY.socso.category2.map((band) => band.skbbk),
    );
  });

  it('leaves the SOCSO employer/employee legs untouched (payroll SKBBK leg unchanged)', () => {
    expect(out.socso.category1).toEqual(DEFAULT_MY_STATUTORY.socso.category1);
    expect(out.socso.category2).toEqual(DEFAULT_MY_STATUTORY.socso.category2);
  });

  it('the SKBBK schedule is identical for Category 1 and Category 2 (what the tab claims)', () => {
    expect(DEFAULT_MY_STATUTORY.socso.category1.map((band) => band.skbbk)).toEqual(
      DEFAULT_MY_STATUTORY.socso.category2.map((band) => band.skbbk),
    );
  });
});

describe('SKBBK route is guarded and its i18n keys exist in all 6 locales', () => {
  it('registers /payroll/configuration/skbbk under the payroll scopedAdmin guard', () => {
    const perms = read('lib/permissions.ts');
    expect(perms.includes("'/payroll/configuration/skbbk'")).toBe(true);
  });

  for (const loc of LOCALES) {
    it(`${loc}.json carries every new payroll.config SKBBK key`, () => {
      const cfg = JSON.parse(read(`messages/${loc}.json`)).payroll.config as Record<string, string>;
      for (const k of I18N_KEYS) {
        expect(typeof cfg[k], `${loc}: ${k}`).toBe('string');
        expect(cfg[k].length).toBeGreaterThan(0);
      }
    });
  }
});
