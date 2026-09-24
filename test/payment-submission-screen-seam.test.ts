/**
 * 20f6c6a8 — CLAIM (b): THE REGISTRY DRIVES THE SCREEN.
 *
 * "Adding a format to the registry makes it appear with no screen change, and removing one makes it
 * disappear." That is a claim about a SEAM, and the only way to pin it is to vary the registry and watch
 * the rendered tree follow — which is what this file does. A source-shape guard ("the page contains no
 * format id") is also here, but it is the weaker half: a page could name no id and still hard-code three
 * cards. The functional half is what makes the claim non-vacuous.
 *
 * ⚠️ WHY THE REGISTRY IS MOCKED WITH A MUTABLE ARRAY RATHER THAN `vi.resetModules()`. Re-importing the
 * module graph between tests would re-import `db/client` and build a SECOND connection pool against the
 * same cluster — on a machine where the binding constraint is exactly that. The mock below closes over one
 * array that each test rewrites, so the page sees a different registry on every render with one module
 * graph and no database at all.
 *
 * NO DATABASE. The page's ONLY read is `listCompanies`; everything else is the registry, the message
 * catalogue and two date helpers. Mocking that one read makes this a pure render test that runs in
 * milliseconds — and keeps the DB-backed claims (a), (c) and (d) in their own file where a real payroll
 * month is actually needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SubmissionFormat, SubmissionGroupKey } from '../app/payroll/payment-submission/registry';

const COMPANY = '11111111-2222-3333-4444-555555555555';

/** The registry the page will see. Rewritten per test; the mock below reads it on every call. */
let formats: SubmissionFormat[] = [];

const fmt = (p: {
  id: string;
  group: SubmissionGroupKey;
  rank: number;
  available?: boolean;
}): SubmissionFormat => {
  const common = {
    id: p.id,
    authority: 'TEST-AUTHORITY',
    group: p.group,
    rank: p.rank,
    labelKey: 'epfBorangA',
    descriptionKey: 'epfBorangADesc',
    periodKind: 'month' as const,
    verification: 'filed-file' as const,
  };
  return p.available === false
    ? { ...common, available: false, unavailableReasonKey: 'groupSalaryEmpty' }
    : {
        ...common,
        available: true,
        build: async () => ({ ok: true as const, filename: 'x.txt', bytes: 'x', contentType: 'text/plain' }),
      };
};

vi.mock('../app/payroll/payment-submission/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/payroll/payment-submission/registry')>();
  return {
    ...actual,
    // The three accessors the screen and the route use. `SUBMISSION_GROUPS` stays REAL — the shelves are
    // not what varies here; what varies is which formats land on them.
    get SUBMISSION_FORMATS() {
      return formats;
    },
    formatsInGroup: (g: SubmissionGroupKey) => formats.filter((f) => f.group === g).sort((a, b) => a.rank - b.rank),
    submissionFormat: (id: string) => formats.find((f) => f.id === id),
  };
});

vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => ({ s: {}, scopeIds: [COMPANY] })) }));
vi.mock('@/core/read', () => ({
  listCompanies: vi.fn(async () => [{ id: COMPANY, name: 'Acme Sdn Bhd', archivedAt: null }]),
}));
// getTranslations → identity, so assertions read as keys rather than as English prose that a catalogue
// edit would break. getLocale is needed because the page formats the month through Intl on the SERVER;
// an undefined locale throws inside the page and reads as a crash instead of a diagnosis.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));

import PaymentSubmissionPage from '../app/payroll/payment-submission/page';

/** Every value of one prop anywhere in a rendered tree. Walks all props, not only `children`. */
function propValues(node: unknown, prop: string, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) propValues(n, prop, acc);
    return acc;
  }
  const el = node as { props?: Record<string, unknown> };
  if (el.props) {
    const v = el.props[prop];
    if (typeof v === 'string') acc.push(v);
    for (const child of Object.values(el.props)) propValues(child, prop, acc);
  }
  return acc;
}

const render = () => PaymentSubmissionPage({ searchParams: Promise.resolve({ companyId: COMPANY }) });

beforeEach(() => {
  formats = [
    fmt({ id: 'test.alpha', group: 'governmentStatutory', rank: 10 }),
    fmt({ id: 'test.beta', group: 'governmentStatutory', rank: 20 }),
  ];
});

describe('20f6c6a8 (b) — the registry drives the screen', () => {
  it('renders exactly the formats the registry declares, and one card each', async () => {
    const shown = propValues(await render(), 'data-format');
    expect(shown).toEqual(['test.alpha', 'test.beta']);
  });

  it('ADDING a format to the registry makes it appear, with no change to the screen', async () => {
    // The page file is not touched between these two renders — only the registry array is. If the screen
    // held a list of its own, the new id could not appear.
    const before = propValues(await render(), 'data-format');
    expect(before).not.toContain('test.gamma');

    formats.push(fmt({ id: 'test.gamma', group: 'governmentStatutory', rank: 30 }));

    expect(propValues(await render(), 'data-format')).toEqual(['test.alpha', 'test.beta', 'test.gamma']);
  });

  it('REMOVING a format from the registry makes it disappear', async () => {
    expect(propValues(await render(), 'data-format')).toContain('test.beta');
    formats = formats.filter((f) => f.id !== 'test.beta');
    const after = propValues(await render(), 'data-format');
    expect(after).not.toContain('test.beta');
    expect(after).toEqual(['test.alpha']);
  });

  it('a format lands on the shelf it declares, not the one it was written next to', async () => {
    formats = [
      fmt({ id: 'test.gov', group: 'governmentStatutory', rank: 10 }),
      fmt({ id: 'test.bank', group: 'bankStatutory', rank: 10 }),
      fmt({ id: 'test.salary', group: 'salary', rank: 10 }),
    ];
    const tree = await render();
    // SUBMISSION_GROUPS is real, and declares salary → bankStatutory → governmentStatutory. The rendered
    // order must be the GROUPS' order, not the array order above (which is deliberately the reverse).
    expect(propValues(tree, 'data-format')).toEqual(['test.salary', 'test.bank', 'test.gov']);
  });

  it('within a shelf the order is the declared RANK, never the array position', async () => {
    formats = [
      fmt({ id: 'test.third', group: 'governmentStatutory', rank: 30 }),
      fmt({ id: 'test.first', group: 'governmentStatutory', rank: 10 }),
      fmt({ id: 'test.second', group: 'governmentStatutory', rank: 20 }),
    ];
    expect(propValues(await render(), 'data-format')).toEqual(['test.first', 'test.second', 'test.third']);
  });

  it('an EMPTY shelf explains itself instead of vanishing', async () => {
    formats = [fmt({ id: 'test.gov', group: 'governmentStatutory', rank: 10 })];
    const tree = await render();
    // Salary and bank-statutory have nothing on them and must still be visible with their reason.
    expect(propValues(tree, 'data-empty-group').sort()).toEqual(['bankStatutory', 'salary']);
    expect(propValues(tree, 'data-empty-group')).not.toContain('governmentStatutory');
  });

  it('an UNAVAILABLE format renders its reason and offers NO download', async () => {
    formats = [
      fmt({ id: 'test.ready', group: 'governmentStatutory', rank: 10 }),
      fmt({ id: 'test.pending', group: 'governmentStatutory', rank: 20, available: false }),
    ];
    const tree = await render();
    // Both are listed — an unavailable format is still shown, so the operator knows it exists.
    expect(propValues(tree, 'data-format')).toEqual(['test.ready', 'test.pending']);
    // Only the available one has a download link.
    expect(propValues(tree, 'data-download')).toEqual(['test.ready']);
    expect(propValues(tree, 'data-unavailable')).toEqual(['test.pending']);
  });

  it('every format prints its PROVENANCE, which is the field the registry refuses to let an author skip', async () => {
    expect(propValues(await render(), 'data-verification')).toEqual(['filed-file', 'filed-file']);
  });
});

describe('20f6c6a8 (b) — the screen knows no authority (the weaker half, kept honest)', () => {
  const PAGE = readFileSync(new URL('../app/payroll/payment-submission/page.tsx', import.meta.url), 'utf8');
  // Comments explain the design and legitimately quote the branches this design is reacting to, so the
  // guard reads the CODE only. Same technique the pack-drift ratchet needs for the same reason.
  const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('names no format id and no agency anywhere in its code', () => {
    for (const literal of ['my.epf', 'my.socso', 'my.lhdn', 'borang-a', 'borang-8a', 'cp39', 'EPFORMA2']) {
      expect(CODE, `the screen must not name ${literal}`).not.toContain(literal);
    }
    for (const agency of ['KWSP', 'PERKESO', 'LHDN', 'SOCSO']) {
      expect(CODE, `the screen must not name ${agency}`).not.toContain(agency);
    }
  });

  it('reads the registry rather than a list of its own', () => {
    expect(CODE).toContain('SUBMISSION_GROUPS.map');
    expect(CODE).toContain('formatsInGroup(group.key)');
  });

  it('resolves the provenance label through an explicit MAP, never a computed key', () => {
    // `t(`verification.${f.verification}`)` renders MISSING_MESSAGE the first time the union grows — on a
    // statutory screen, beside a download button. The map is checked by tsc instead.
    expect(CODE).not.toMatch(/t\(`[^`]*\$\{/);
    expect(CODE).toContain('verificationLabel[f.verification]');
  });
});
