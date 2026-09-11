/**
 * 7f69bd71 (r268) — both reset records leave the everyday tabs for ONE "Reset records" sub-screen,
 * reached from the foot of Leave Adjustments. No data change: the two archive tables and every row in
 * them are untouched, and every old address and every saved CSV link keeps working.
 *
 * TWO HALVES. The SOURCE-SHAPE half pins the promises a later round could quietly undo without any
 * behaviour test noticing (the house style of test/clocking-location-page.test.ts): one guarded page on
 * the existing leaveConfig column, no tab row and no row heading on it (a sub-screen with a back link),
 * the two records as server components with a hidden `record` on their picker forms, the CSV route
 * handlers untouched, the map down to two tabs per row with the two record ids excluded by type, the
 * Leave Adjustments row owning the sub-screen, ONE foot link and nowhere else, four stubs that name their
 * sub-tab FIRST and never chain, the reset script's four address strings, and the strings in six locales.
 * The RENDER half renders the real page with a real database and a seeded capture in EACH archive (a 200
 * is not a render check, and neither is a source scan): both sub-tabs with rows, picker, Show, CSV; the
 * picker choosing an older capture and ignoring an unknown one; Leave Adjustments for real with two tabs
 * and the foot link; the row tab strip for both Entitlements ids with two tabs; the four stubs redirecting
 * with `?capture=` kept; and the sidebar predicate lighting Leave Adjustments — not Entitlements — on the
 * sub-screen and on both stubs on the way through.
 *
 * ⚠️ FILE-LEVEL MOCKS: requireAdmin() is a fake returning the module-level ADMIN; redirect() throws and
 * records where it sent the browser; getTranslations is a REAL translator over messages/en.json
 * (next-intl's own `createTranslator`, rethrowing MISSING_MESSAGE / FORMATTING_ERROR) so the assertions
 * below read SENTENCES, not key names; next/headers gives an empty cookie jar. Server components are
 * `async` and react-dom/server cannot render one, so `settle()` walks the element tree and awaits every
 * async component before `renderToStaticMarkup` — the Next RSC renderer does the same job in production.
 *
 * NON-VACUITY (done by the builder, re-derivable by the verifier): put `entitlementArchive` back under
 * the Entitlements group in a copy of components/leave-config-map.tsx and the "two tabs each" case AND
 * the rendered-tab-strip case fail; drop the forwarding loop from one stub and its `?capture=` case fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

let ADMIN: SessionContext;
vi.mock('../lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/authz')>()),
  requireAdmin: async () => ADMIN,
}));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        // ⚠️ LOAD-BEARING: next-intl swallows a missing or malformed message and hands back the key.
        onError: (e) => {
          throw e;
        },
      }),
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import ResetRecordsPage from '../app/admin/leave-config/records/page';
import EntitlementRecordStub from '../app/admin/leave-config/records/entitlement/page';
import BalanceRecordStub from '../app/admin/leave-config/records/balances/page';
import OlderArchiveStub from '../app/admin/leave/entitlements/archive/page';
import OlderLedgerArchiveStub from '../app/admin/leave/entitlements/ledger-archive/page';
import AdjustmentsPage from '../app/admin/leave-config/adjustments/page';
import {
  LEAVE_CONFIG_MAP,
  LEAVE_CONFIG_RECORD_IDS,
  LEAVE_CONFIG_RECORD_LABEL_ID,
  LEAVE_CONFIG_RECORDS_HREF,
  LeaveConfigMap,
  leaveConfigRecordHref,
  leaveConfigRecordOf,
  leaveConfigScreenTitle,
} from '../components/leave-config-map';
import { isNavRowActive, isParentActive } from '../components/nav-flyout';
import { leavePack } from '../packs/leave';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(root, rel));
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`))])) as Record<
  (typeof LOCALES)[number],
  Record<string, unknown>
>;
const en = CATALOGUES.en as { admin: Record<string, Record<string, string>>; nav: Record<string, string> };
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

const PAGE = 'app/admin/leave-config/records/page.tsx';
const CONFIGURATION = 'components/leave/reset-record-configuration.tsx';
const BALANCES = 'components/leave/reset-record-balances.tsx';
const STUB_ENTITLEMENT = 'app/admin/leave-config/records/entitlement/page.tsx';
const STUB_BALANCES = 'app/admin/leave-config/records/balances/page.tsx';
const STUB_OLDER_ARCHIVE = 'app/admin/leave/entitlements/archive/page.tsx';
const STUB_OLDER_LEDGER = 'app/admin/leave/entitlements/ledger-archive/page.tsx';
const ADJUSTMENTS = 'app/admin/leave-config/adjustments/page.tsx';
const ROUTE = '/admin/leave-config/records';
const CSV_CONFIGURATION = '/admin/leave/entitlements/archive/export';
const CSV_BALANCES = '/admin/leave/entitlements/ledger-archive/export';

/** The index of `needle` in `src`, asserted PRESENT first — `indexOf` gives -1 for an absent needle. */
const at = (src: string, needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `${JSON.stringify(needle)} is in the source`).toBeGreaterThan(-1);
  return i;
};
/** CODE only — the files' headers deliberately QUOTE what they replaced. */
const withoutComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** Strip <script> before counting — a key in a payload is not a screen (CLAUDE.md §8). */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

// ────────────────────────────────── SOURCE SHAPE ──────────────────────────────────

describe('7f69bd71 — one guarded sub-screen on the existing leaveConfig column; the two tab addresses are stubs off it', () => {
  it('the page exists, guards itself, and is the ONE records route on the leaveConfig key', () => {
    expect(exists(PAGE)).toBe(true);
    expect(read(PAGE)).toContain('requireAdmin()');
    expect(REGISTERED_ROUTES.has(ROUTE)).toBe(true);
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(leaveConfig.routes).toContain(ROUTE);
    expect(leaveConfig.guard).toBe('requireAdmin');
    // The two retired tab addresses are stubs: off the key (a stub is not a screen the grid can describe).
    for (const stub of ['/admin/leave-config/records/entitlement', '/admin/leave-config/records/balances']) {
      expect(REGISTERED_ROUTES.has(stub), `${stub} is a stub and must not be registered`).toBe(false);
    }
    // No separate permission, switch or setting for the records: nothing new in SCREENS.
    expect(SCREENS.filter((s) => s.routes.some((r) => r.startsWith(ROUTE)))).toHaveLength(1);
  });

  it('a sub-screen, not a row and not a tab: its own heading, a back link to Leave Adjustments, no tab row, no row helper', () => {
    const code = withoutComments(read(PAGE));
    expect(code).toContain("getTranslations('admin.leaveConfigRecords')");
    expect(code).toContain("title={t('pageTitle')}");
    expect(code).toContain("description={t('pageDescription')}");
    expect(code).toContain("back={{ href: leaveConfigScreenHref('adjustments'), label: tNav('leaveAdjustments') }}");
    expect(code).not.toContain('<LeaveConfigMap');
    expect(code).not.toContain('leaveConfigPageHeader(');
    expect(code).not.toContain('leaveConfigScreenTitle(\'leaveTypes\')');
    // Two sub-tabs, labelled by the tab strings the reporter already knows, addressed through the map.
    expect(code).toContain('LEAVE_CONFIG_RECORD_IDS.map(');
    expect(code).toContain('leaveConfigScreenTitle(LEAVE_CONFIG_RECORD_LABEL_ID[id])');
    expect(code).toContain('<Link href={leaveConfigRecordHref(id)}');
    expect(code).toContain('aria-current="page"');
    expect(code).toContain("aria-label={t('tabsLabel')}");
    // The chosen record is parsed by the map's reader, and only the chosen one is rendered.
    expect(code).toContain('const record = leaveConfigRecordOf(sp.record);');
    expect(code).toContain("{record === 'balances' ? (");
    expect(code).toContain('<ResetRecordBalances s={s} capture={sp.capture} />');
    expect(code).toContain('<ResetRecordConfiguration s={s} capture={sp.capture} />');
    // Read-only by construction.
    expect(code).not.toContain("'use server'");
    expect(code).not.toContain('<form');
  });

  it('the two records are SERVER components carrying exactly what their tabs showed, with a hidden `record` on the picker', () => {
    for (const [rel, record, csv, reader] of [
      [CONFIGURATION, 'configuration', CSV_CONFIGURATION, 'listEntitlementResetArchive'],
      [BALANCES, 'balances', CSV_BALANCES, 'listLeaveLedgerResetArchive'],
    ] as const) {
      const code = withoutComments(read(rel));
      expect(code, `${rel} is a server component`).not.toContain("'use client'");
      expect(code).not.toContain("'use server'");
      expect(code, 'no mutating form — and, on the balance record, no re-capture button').not.toContain('<form action=');
      expect(code, 'readers come through the pack facade').toContain(`${reader} } from '@/packs/leave/service'`);
      expect(code).toContain('name="capture"');
      expect(code).toContain(`<input type="hidden" name="record" value="${record}" />`);
      expect(at(code, `name="record" value="${record}"`)).toBeLessThan(at(code, 'name="capture"'));
      expect(code, 'the picker form has no action: it GETs back to whatever address it is on').toMatch(/<form className="[^"]*">/);
      expect(code).toContain("t('show')");
      expect(code).toContain("t('downloadCsv')");
      expect(code, 'an unknown capture is ignored, not answered with an empty table').toContain(
        'captures.find((c) => c.captureTag === capture)?.captureTag ?? captures[0]?.captureTag',
      );
      expect(code, 'the CSV link is unchanged').toContain(`\`${csv}?capture=\${encodeURIComponent(chosen)}\``);
      expect(code).toContain("t('pageDescription')");
      expect(code).toContain("t('intro')");
      expect(code).toContain("t('notAnUndo')");
      expect(code).toContain("t('feedsNothing')");
      expect(code).toContain("t('emptyTitle')");
    }
    // F45's nine columns and four layer labels; F46's eight columns, the two counts and the no-request line.
    const configuration = withoutComments(read(CONFIGURATION));
    for (const col of ['colLayer', 'colTemplateOrRule', 'colScheme', 'colLeaveType', 'colCompany', 'colGrade', 'colEmploymentType', 'colEntitlement', 'colInForce', 'colNote'])
      expect(configuration).toContain(`t('${col}')`);
    for (const layer of ['layerScheme', 'layerTemplate', 'layerRule', 'layerPolicy']) expect(configuration).toContain(`t('${layer}')`);
    const balances = withoutComments(read(BALANCES));
    for (const col of ['colLayer', 'colEmployee', 'colLeaveType', 'colEntryType', 'colDays', 'colEffectiveOn', 'colReason', 'colNote'])
      expect(balances).toContain(`t('${col}')`);
    expect(balances).toContain("t('counts', { ledger: ledgerCount, audit: auditCount })");
    expect(balances).toContain("t('noRequest')");
    expect(balances).toContain("t('noLeaveHistory')");
  });

  it('the two CSV route handlers are exactly where every saved download link expects them', () => {
    for (const rel of ['app/admin/leave/entitlements/archive/export/route.ts', 'app/admin/leave/entitlements/ledger-archive/export/route.ts']) {
      expect(exists(rel), rel).toBe(true);
      expect(read(rel)).toContain('export async function GET');
      expect(read(rel)).not.toContain('redirect(');
    }
    expect(exists('app/admin/leave-config/records/export/route.ts'), 'no new export handler').toBe(false);
  });
});

describe('7f69bd71 — the map: two tabs per row, the record ids excluded by type, the sub-screen addressed from one place', () => {
  it('Entitlements and Leave Adjustments have two tabs each and neither names a record', () => {
    const byGroup = Object.fromEntries(LEAVE_CONFIG_MAP.map((g) => [g.id, g.items.map((i) => i.id)]));
    expect(byGroup.entitlements).toEqual(['leaveTypes', 'entitlementTables']);
    expect(byGroup.adjustments).toEqual(['adjustments', 'importLeaveData']);
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain('/admin/leave-config/records/entitlement');
    expect(hrefs).not.toContain('/admin/leave-config/records/balances');
    expect(hrefs, 'the sub-screen is not a menu entry').not.toContain(ROUTE);
    // Excluded by TYPE, joining the replacementLeave / payrollImpact precedent — pinned in the source.
    expect(read('components/leave-config-map.tsx')).toContain("'replacementLeave' | 'payrollImpact' | 'entitlementArchive' | 'ledgerArchive'");
  });

  it('the record helpers: two ids, their labels are the old tab strings, their addresses are the sub-tabs', async () => {
    expect(LEAVE_CONFIG_RECORDS_HREF).toBe(ROUTE);
    expect([...LEAVE_CONFIG_RECORD_IDS]).toEqual(['configuration', 'balances']);
    expect(LEAVE_CONFIG_RECORD_LABEL_ID).toEqual({ configuration: 'entitlementArchive', balances: 'ledgerArchive' });
    expect(leaveConfigRecordHref('configuration')).toBe('/admin/leave-config/records?record=configuration');
    expect(leaveConfigRecordHref('balances')).toBe('/admin/leave-config/records?record=balances');
    expect(leaveConfigRecordOf(undefined)).toBe('configuration');
    expect(leaveConfigRecordOf('balances')).toBe('balances');
    expect(leaveConfigRecordOf('configuration')).toBe('configuration');
    expect(leaveConfigRecordOf('junk')).toBe('configuration');
    expect(leaveConfigRecordOf('')).toBe('configuration');
    // The ids stay in the wider union so the sub-tab labels still resolve from the one map key.
    expect(await leaveConfigScreenTitle('entitlementArchive')).toBe('Configuration record');
    expect(await leaveConfigScreenTitle('ledgerArchive')).toBe('Balance record');
  });

  it('the Leave Adjustments row owns the sub-screen; Entitlements owns no record path', () => {
    const rows = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    expect(rows.find((r) => r.labelKey === 'leaveAdjustments')!.ownedSubpaths).toEqual(['/admin/leave-config/import', ROUTE]);
    expect(rows.find((r) => r.labelKey === 'leaveEntitlements')!.ownedSubpaths).toEqual(['/admin/leave-config/entitlement-tables']);
    // Not a row: the fly-out has the same five children it had.
    expect(rows.map((r) => r.href)).not.toContain(ROUTE);
    expect(rows).toHaveLength(5);
  });
});

describe('7f69bd71 — one foot link on Adjust balances, below the recent adjustments, and nowhere else', () => {
  it('the link sits after the recent adjustments card, resolves through the map constant, and reads footLink', () => {
    const code = withoutComments(read(ADJUSTMENTS));
    expect(code).toContain("getTranslations('admin.leaveConfigRecords')");
    expect(code).toContain('<Link href={LEAVE_CONFIG_RECORDS_HREF}');
    expect(code).toContain("{tRecords('footLink')}");
    expect(at(code, "t('adjustmentsRecentTitle')")).toBeLessThan(at(code, '<Link href={LEAVE_CONFIG_RECORDS_HREF}'));
    expect(count(code, 'LEAVE_CONFIG_RECORDS_HREF'), 'one link (one import, one use)').toBe(2);
  });

  it('Import, Entitlements, Entitlement tables, Generate, Approval and Company rules carry no link to the records', () => {
    for (const rel of [
      'app/admin/leave-config/import/page.tsx',
      'app/admin/leave-config/types/page.tsx',
      'app/admin/leave-config/entitlement-tables/page.tsx',
      'app/admin/leave-config/generate/page.tsx',
      'app/admin/leave-config/approval-chains/page.tsx',
      'app/admin/leave-config/company-rules/page.tsx',
    ]) {
      const code = withoutComments(read(rel));
      expect(code, rel).not.toContain('LEAVE_CONFIG_RECORDS_HREF');
      expect(code, rel).not.toContain('leaveConfigRecordHref(');
      expect(code, rel).not.toContain('/admin/leave-config/records');
      expect(code, rel).not.toContain("leaveConfigScreenHref('entitlementArchive')");
      expect(code, rel).not.toContain("leaveConfigScreenHref('ledgerArchive')");
    }
  });
});

describe('7f69bd71 — four stubs: sub-tab named FIRST, the query forwarded, no guard, no chain', () => {
  it.each([
    [STUB_ENTITLEMENT, 'configuration'],
    [STUB_BALANCES, 'balances'],
    [STUB_OLDER_ARCHIVE, 'configuration'],
    [STUB_OLDER_LEDGER, 'balances'],
  ] as const)('%s → ?record=%s, then whatever came in', (rel, record) => {
    const s = read(rel);
    expect(s).toContain("import { redirect } from 'next/navigation';");
    expect(s).toContain(`const usp = new URLSearchParams({ record: '${record}' });`);
    // The loop, not the token (the round3 lesson): the params are READ, and the redirect is BUILT from them.
    expect(s).toMatch(/for \(const \[k, v\] of Object\.entries\(sp\)\)/);
    expect(s).toMatch(/usp\.set\(k, v\)/);
    expect(s).toContain('redirect(`/admin/leave-config/records${qs ? `?${qs}` : \'\'}`);');
    expect(/requireAdmin|scopedAdmin|scopedSession/.test(s), 'a stub carries no guard').toBe(false);
    expect(s, 'never a chain through another stub').not.toMatch(/redirect\(`\/admin\/leave-config\/records\/(entitlement|balances)/);
    expect(withoutComments(s)).not.toContain('<LeaveConfigMap');
  });

  it('the reset script points its operator at the new addresses', () => {
    const script = read('scripts/reset-entitlement-configuration.ts');
    expect(script).toContain("out.push('  Read the record at /admin/leave-config/records?record=configuration.');");
    expect(script).toContain("out.push('  Read the record at /admin/leave-config/records?record=balances.');");
    expect(script).toContain('Read at /admin/leave-config/records?record=configuration.');
    expect(script).toContain('Read at /admin/leave-config/records?record=balances.');
    expect(script).not.toContain('/admin/leave-config/records/entitlement');
    expect(script).not.toContain('/admin/leave-config/records/balances');
  });
});

describe('7f69bd71 — the strings, six locales', () => {
  const NEW_OR_REWORDED = [
    'admin.leaveConfigRecords.pageTitle',
    'admin.leaveConfigRecords.pageDescription',
    'admin.leaveConfigRecords.footLink',
    'admin.leaveConfigRecords.tabsLabel',
    'admin.leaveLedgerArchive.pageDescription',
    'admin.leaveLedgerArchive.intro',
    'admin.leaveLedgerArchive.emptyBody',
    'admin.entitlementArchive.emptyBody',
  ];

  it('every new or reworded key exists in all six catalogues and is not left in English outside en', () => {
    for (const key of NEW_OR_REWORDED) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const loc of LOCALES) {
        const v = getPath(CATALOGUES[loc], key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect((v as string).trim().length, `${loc} ${key} is blank`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} untranslated`).not.toBe(enValue);
      }
    }
    // The sub-tab labels the page reuses stay where they were, in all six.
    for (const loc of LOCALES) {
      expect(typeof getPath(CATALOGUES[loc], 'admin.leaveConfigMap.item.entitlementArchive'), loc).toBe('string');
      expect(typeof getPath(CATALOGUES[loc], 'admin.leaveConfigMap.item.ledgerArchive'), loc).toBe('string');
    }
  });

  it('the English says what the screen is, and the Balance record no longer describes only the August reset', () => {
    expect(en.admin.leaveConfigRecords.pageTitle).toBe('Reset records');
    expect(en.admin.leaveConfigRecords.footLink).toBe('Records of past resets');
    expect(en.admin.leaveConfigRecords.pageDescription).toMatch(/[Rr]ead-only/);
    for (const key of ['pageDescription', 'intro', 'emptyBody'] as const) {
      const v = en.admin.leaveLedgerArchive[key];
      expect(v, key).not.toMatch(/Medical Leave and Hospitalisation Leave/);
      expect(v, key).not.toMatch(/one-off/);
      expect(v, key).toMatch(/reset/);
    }
    expect(en.admin.entitlementArchive.emptyBody).not.toMatch(/Benefit Scheme/);
    expect(en.admin.entitlementArchive.emptyBody).toMatch(/reset/);
    // Kept as they were: true of every capture (debits were kept both times).
    expect(en.admin.leaveLedgerArchive.notAnUndo).toContain('not an undo button');
    expect(en.admin.leaveLedgerArchive.feedsNothing).toContain('feeds nothing');
  });

  it.each(LOCALES)('%s FORMATS every string this screen renders — not just carries it', (loc) => {
    for (const ns of ['admin.leaveConfigRecords', 'admin.leaveLedgerArchive', 'admin.entitlementArchive'] as const) {
      const t = createTranslator({
        locale: loc,
        messages: CATALOGUES[loc] as Record<string, unknown>,
        namespace: ns,
        onError: (e) => {
          throw e;
        },
      });
      const keys = Object.keys(getPath(CATALOGUES[loc], ns) as Record<string, unknown>);
      for (const key of keys) {
        const out = key === 'counts' ? t(key as never, { ledger: 2, audit: 1 } as never) : t(key as never);
        expect(out.length, `${loc} ${ns}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

// ────────────────────────────────── RENDER ──────────────────────────────────

/** Await every async server component in an element tree so react-dom/server can render it. */
const isAsync = (f: unknown) => typeof f === 'function' && (f as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction';
async function settle(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(settle));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (isAsync(el.type)) return settle(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  if (el.props && el.props.children !== undefined) return cloneElement(el, { children: await settle(el.props.children) });
  return node;
}
function toMarkup(tree: ReactNode): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'Asia/Kuala_Lumpur',
      messages: CATALOGUES.en as never,
      children: tree as never,
    }),
  );
}
const renderRecords = async (sp: Record<string, string> = {}) =>
  visible(toMarkup(await settle(await ResetRecordsPage({ searchParams: Promise.resolve(sp) }))));
const renderAdjustments = async () => visible(toMarkup(await settle(await AdjustmentsPage({ searchParams: Promise.resolve({}) }))));
const renderTabs = async (current: 'leaveTypes' | 'entitlementTables' | 'adjustments' | 'importLeaveData') =>
  visible(toMarkup(await settle(await LeaveConfigMap({ current }))));
/** Run a stub to its redirect and return where it sent the browser. */
async function runStub(
  stub: (p: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<unknown>,
  sp: Record<string, string | string[] | undefined>,
) {
  LAST_REDIRECT = '';
  await expect(stub({ searchParams: Promise.resolve(sp) })).rejects.toThrow('NEXT_REDIRECT');
  return LAST_REDIRECT;
}

let b: Base;
const CONFIG_NEW = 'r268-config-2026-09-11';
const CONFIG_OLD = 'r268-config-release-one';
const LEDGER_NEW = 'r268-accruals-2026-09-11';
const LEDGER_OLD = 'r268-ledger-2026-08-12';
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  ADMIN = adminCtx(b);
  const now = new Date();
  const older = new Date(now.getTime() - 30 * DAY);
  // A capture in EACH archive, written straight in: the page's job is to SHOW rows, not to create them
  // (the capture paths have their own tests). Two captures per archive so the picker has a choice.
  await owner.db.insert(schema.entitlementResetArchive).values([
    { tenantId: b.tenantId, captureTag: CONFIG_NEW, capturedAt: now, layer: 'template', schemeName: 'Annual leave table — grade A', leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', companyName: 'Seeded Co', entitlementText: '0-2 yrs: 14 days, max brought forward 5', validFromText: '2026-01-01', validToText: '—', note: null },
    { tenantId: b.tenantId, captureTag: CONFIG_NEW, capturedAt: now, layer: 'rule', schemeName: 'Rule: everyone at Seeded Co', leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', companyName: 'Seeded Co', entitlementText: 'Annual leave table — grade A', validFromText: '2026-01-01', validToText: '—', note: null },
    { tenantId: b.tenantId, captureTag: CONFIG_OLD, capturedAt: older, layer: 'scheme', schemeName: 'Grade 12-15 Permanent', schemeCategory: 'Permanent', leaveTypeName: 'Medical Leave', leaveTypeCode: 'ML', companyName: 'Seeded Co', entitlementText: '14 days', validFromText: '—', validToText: '—', note: null },
  ]);
  await owner.db.insert(schema.leaveLedgerResetArchive).values([
    { tenantId: b.tenantId, captureTag: LEDGER_NEW, capturedAt: now, layer: 'ledger', employeeName: 'Mei Ling Seeded', employeeCode: 'E-268', companyName: 'Seeded Co', leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', entryType: 'accrual', daysText: '14.00', effectiveOnText: '2026-01-01', reason: 'accrual for 2026', sourceRequestText: null, note: null },
    { tenantId: b.tenantId, captureTag: LEDGER_NEW, capturedAt: now, layer: 'recalc_audit', employeeName: 'Mei Ling Seeded', employeeCode: 'E-268', companyName: 'Seeded Co', leaveTypeName: 'Annual Leave', leaveTypeCode: 'AL', daysText: '-14.00', effectiveOnText: '2026-09-11', reason: 'reset', entitlementText: 'previous 14.00 → new 0.00 (delta −14.00)', note: null },
    { tenantId: b.tenantId, captureTag: LEDGER_OLD, capturedAt: older, layer: 'ledger', employeeName: 'Older Capture Person', employeeCode: 'E-001', companyName: 'Seeded Co', leaveTypeName: 'Hospitalisation Leave', leaveTypeCode: 'HL', entryType: 'accrual', daysText: '60.00', effectiveOnText: '2026-01-06', reason: 'accrual', sourceRequestText: null, note: null },
  ]);
});
afterAll(async () => {
  await closeAll();
});

describe('7f69bd71 — the Reset records page renders, for real, both sub-tabs with a seeded capture in each archive', () => {
  it('opens on the Configuration record: heading, back link, two sub-tabs, picker on the newest capture, Show, CSV, the rows', async () => {
    const html = await renderRecords();
    expect(html).toContain('<h1 class="text-xl font-semibold tracking-tight">Reset records</h1>');
    expect(html).toContain(en.admin.leaveConfigRecords.pageDescription);
    expect(html).toMatch(/<a[^>]*href="\/admin\/leave-config\/adjustments"[^>]*>← Leave Adjustments<\/a>/);
    // The sub-tab strip: the current one is a span, the other a link to its own address.
    expect(html).toContain('data-testid="reset-records-tabs"');
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toMatch(/<span aria-current="page"[^>]*>Configuration record<\/span>/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/leave-config\/records\?record=balances"[^>]*>Balance record<\/a>/);
    // No row tab strip: the page is a sub-screen, not a tab of Entitlements or Leave Adjustments.
    expect(html).not.toContain('data-testid="leave-config-tabs"');
    expect(count(html, 'Leave types')).toBe(0);
    expect(count(html, 'Adjust balances')).toBe(0);
    // The record itself: intro, picker on the newest capture, hidden record, Show, CSV to the old handler.
    expect(html).toContain(en.admin.entitlementArchive.pageDescription);
    expect(html).toContain('<input type="hidden" name="record" value="configuration"/>');
    expect(html).toMatch(/<option value="r268-config-2026-09-11"[^>]*selected/);
    expect(html).toContain('r268-config-2026-09-11 · ');
    expect(html).toContain(' · 2</option>');
    expect(html).toContain('r268-config-release-one · ');
    expect(html).toContain('>Show</button>');
    expect(html).toContain(`href="${CSV_CONFIGURATION}?capture=r268-config-2026-09-11"`);
    expect(html).toContain('>Download as CSV</a>');
    // The rows of the newest capture, under the template/rule header, and not the older capture's.
    expect(html).toContain('Annual leave table — grade A');
    expect(html).toContain('Rule: everyone at Seeded Co');
    expect(html).toContain('>Entitlement table</td>');
    expect(html).toContain('>Eligibility rule</td>');
    expect(html).toContain('Entitlement table / rule');
    expect(html).not.toContain('Grade 12-15 Permanent');
    expect(count(html, '<form'), 'one GET form, nothing that saves').toBe(1);
    expect(html).not.toMatch(/<form[^>]*action=/);
  });

  it('?capture= picks an older capture (with its scheme header); an unknown capture falls back to the newest', async () => {
    const older = await renderRecords({ capture: CONFIG_OLD });
    expect(older).toMatch(/<option value="r268-config-release-one"[^>]*selected/);
    expect(older).toContain('Grade 12-15 Permanent');
    expect(older).toContain('>Benefit scheme</td>');
    expect(older).not.toContain('Entitlement table / rule');
    expect(older).not.toContain('Annual leave table — grade A');
    expect(older).toContain(`href="${CSV_CONFIGURATION}?capture=r268-config-release-one"`);
    const unknown = await renderRecords({ capture: 'no-such-capture' });
    expect(unknown).toMatch(/<option value="r268-config-2026-09-11"[^>]*selected/);
    expect(unknown).toContain('Annual leave table — grade A');
  });

  it('?record=balances renders the Balance record: reworded intro, counts, rows, no-request line, CSV, hidden record', async () => {
    const html = await renderRecords({ record: 'balances' });
    expect(html).toMatch(/<span aria-current="page"[^>]*>Balance record<\/span>/);
    expect(html).toMatch(/<a[^>]*href="\/admin\/leave-config\/records\?record=configuration"[^>]*>Configuration record<\/a>/);
    expect(count(html, 'aria-current="page"')).toBe(1);
    expect(html).toContain(en.admin.leaveLedgerArchive.pageDescription);
    expect(html).not.toContain('Medical Leave and Hospitalisation Leave');
    expect(html).toContain('<input type="hidden" name="record" value="balances"/>');
    expect(html).toMatch(/<option value="r268-accruals-2026-09-11"[^>]*selected/);
    expect(html).toContain('1 balance records and 1 recalculation history entries in this record.');
    expect(html).toContain('Mei Ling Seeded');
    expect(html).toContain('E-268');
    expect(html).toContain('>Balance record</td>');
    expect(html).toContain('>Recalculation history</td>');
    expect(html).toContain('previous 14.00 → new 0.00 (delta −14.00)');
    expect(html).toContain('Not from a leave request');
    expect(html).toContain(`href="${CSV_BALANCES}?capture=r268-accruals-2026-09-11"`);
    expect(html).not.toContain('Older Capture Person');
    expect(html).not.toContain('Annual leave table — grade A');
    expect(count(html, '<form')).toBe(1);
    expect(html).not.toMatch(/<form[^>]*action=/);
    // The older ledger capture, on request.
    const older = await renderRecords({ record: 'balances', capture: LEDGER_OLD });
    expect(older).toContain('Older Capture Person');
    expect(older).toContain('1 balance records and 0 recalculation history entries in this record.');
    expect(older).toContain(`href="${CSV_BALANCES}?capture=r268-ledger-2026-08-12"`);
    expect(older).not.toContain('Mei Ling Seeded');
  });

  it('an unknown ?record= is the Configuration record', async () => {
    const html = await renderRecords({ record: 'junk' });
    expect(html).toMatch(/<span aria-current="page"[^>]*>Configuration record<\/span>/);
    expect(html).toContain('Annual leave table — grade A');
  });
});

describe('7f69bd71 — Leave Adjustments and Entitlements render two tabs; the foot link is on Adjust balances', () => {
  it('Leave Adjustments, for real: two tabs, no Balance record tab, the foot link below the recent adjustments', async () => {
    const html = await renderAdjustments();
    expect(html).toContain('<h1 class="text-xl font-semibold tracking-tight">Leave Adjustments</h1>');
    const strip = html.slice(at(html, 'data-testid="leave-config-tabs"'), html.indexOf('</nav>'));
    expect(count(strip, '<li ')).toBe(2);
    expect(strip).toMatch(/<span aria-current="page"[^>]*>Adjust balances<\/span>/);
    expect(strip).toMatch(/<a[^>]*href="\/admin\/leave-config\/import"[^>]*>Import leave data<\/a>/);
    expect(count(html, 'Balance record')).toBe(0);
    expect(count(html, 'Configuration record')).toBe(0);
    expect(html).toMatch(/<a[^>]*href="\/admin\/leave-config\/records"[^>]*>Records of past resets<\/a>/);
    expect(count(html, 'Records of past resets'), 'one link').toBe(1);
    expect(at(html, en.admin.leave.adjustmentsRecentTitle)).toBeLessThan(at(html, 'Records of past resets'));
  });

  it('the Entitlements tab strip, as both of its pages mount it: two tabs, no Configuration record', async () => {
    for (const current of ['leaveTypes', 'entitlementTables'] as const) {
      const html = await renderTabs(current);
      expect(count(html, '<li ')).toBe(2);
      expect(html).toContain('Leave types');
      expect(html).toContain('Entitlement tables');
      expect(html).not.toContain('Configuration record');
      expect(html).not.toContain('/admin/leave-config/records');
      expect(count(html, 'aria-current="page"')).toBe(1);
    }
    // …and the pages really do mount it with those ids (the r266 rule, re-read here so this render is theirs).
    expect(withoutComments(read('app/admin/leave-config/types/page.tsx'))).toContain('<LeaveConfigMap current="leaveTypes" />');
    expect(withoutComments(read('app/admin/leave-config/entitlement-tables/page.tsx'))).toContain('<LeaveConfigMap current="entitlementTables" />');
    const imp = await renderTabs('importLeaveData');
    expect(count(imp, '<li ')).toBe(2);
    expect(imp).not.toContain('Balance record');
  });
});

describe('7f69bd71 — the four stubs land on the right sub-tab with ?capture= kept', () => {
  it('records/entitlement and records/balances → the sub-screen, record first, capture kept, other params forwarded', async () => {
    expect(await runStub(EntitlementRecordStub, { capture: 'fe9c73bc-config-2026-09-11' })).toBe(
      '/admin/leave-config/records?record=configuration&capture=fe9c73bc-config-2026-09-11',
    );
    expect(await runStub(EntitlementRecordStub, {})).toBe('/admin/leave-config/records?record=configuration');
    expect(await runStub(BalanceRecordStub, { capture: 'c8052ae3-2026-08-12' })).toBe(
      '/admin/leave-config/records?record=balances&capture=c8052ae3-2026-08-12',
    );
    expect(await runStub(BalanceRecordStub, {})).toBe('/admin/leave-config/records?record=balances');
    // Encoded, arrays reduced to their first value, other params carried.
    expect(await runStub(EntitlementRecordStub, { capture: 'pre reset/2026', toast: 'x' })).toBe(
      '/admin/leave-config/records?record=configuration&capture=pre+reset%2F2026&toast=x',
    );
    expect(await runStub(BalanceRecordStub, { capture: ['first', 'second'] })).toBe('/admin/leave-config/records?record=balances&capture=first');
  });

  it('the two older stubs point straight at the sub-screen — one hop, never through the newer stubs', async () => {
    expect(await runStub(OlderArchiveStub, { capture: '0398-release-one' })).toBe(
      '/admin/leave-config/records?record=configuration&capture=0398-release-one',
    );
    expect(await runStub(OlderLedgerArchiveStub, { capture: 'c8052ae3-2026-08-12' })).toBe(
      '/admin/leave-config/records?record=balances&capture=c8052ae3-2026-08-12',
    );
    expect(await runStub(OlderArchiveStub, {})).toBe('/admin/leave-config/records?record=configuration');
    expect(await runStub(OlderLedgerArchiveStub, {})).toBe('/admin/leave-config/records?record=balances');
  });
});

describe('7f69bd71 — the sidebar predicate lights Leave Adjustments on the sub-screen, and on both stubs on the way through', () => {
  const rows = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
  const adjustments = rows.find((r) => r.labelKey === 'leaveAdjustments')!;
  const entitlements = rows.find((r) => r.labelKey === 'leaveEntitlements')!;

  it.each([
    ['/admin/leave-config/records', '?record=configuration'],
    ['/admin/leave-config/records', '?record=balances&capture=x'],
    ['/admin/leave-config/records', ''],
    ['/admin/leave-config/records/entitlement', '?capture=x'],
    ['/admin/leave-config/records/balances', ''],
  ])('%s%s → Leave Adjustments lit, Entitlements dark, exactly one row', (pathname, search) => {
    expect(isNavRowActive(pathname, search, adjustments)).toBe(true);
    expect(isNavRowActive(pathname, search, entitlements)).toBe(false);
    expect(rows.filter((r) => isNavRowActive(pathname, search, r))).toHaveLength(1);
    // The Leave config parent node opens too (the sidebar feeds it the same owned paths).
    expect(isParentActive(pathname, rows.flatMap((c) => [c.href, ...(c.ownedSubpaths ?? [])]))).toBe(true);
  });

  it('the other tabs still light their own rows, and nothing else lights on the records', () => {
    expect(isNavRowActive('/admin/leave-config/entitlement-tables', '', entitlements)).toBe(true);
    expect(isNavRowActive('/admin/leave-config/entitlement-tables', '', adjustments)).toBe(false);
    expect(isNavRowActive('/admin/leave-config/import', '', adjustments)).toBe(true);
    expect(isNavRowActive('/admin/leave-config/adjustments', '', adjustments)).toBe(true);
    expect(isNavRowActive('/admin/leave-config/recordsx', '', adjustments), 'prefix means a path segment').toBe(false);
  });
});

describe('7f69bd71 verify fixes — the stub owns its record, and the explanation names no reset', () => {
  const STUBS: ReadonlyArray<readonly [string, string]> = [
    ['app/admin/leave/entitlements/archive/page.tsx', 'configuration'],
    ['app/admin/leave/entitlements/ledger-archive/page.tsx', 'balances'],
    ['app/admin/leave-config/records/entitlement/page.tsx', 'configuration'],
    ['app/admin/leave-config/records/balances/page.tsx', 'balances'],
  ];

  it('a forwarded ?record= cannot send a bookmark to the other record', () => {
    // Found by the verify pass: the forwarding loop ran AFTER `record` was seeded, so
    // /admin/leave/entitlements/archive?record=balances landed on the BALANCE record.
    for (const [file, record] of STUBS) {
      const src = read(file);
      expect(src, `${file}: seeds its own record`).toContain(`record: '${record}'`);
      expect(src, `${file}: the loop must skip record`).toContain("if (k === 'record') continue;");
      const loopAt = src.indexOf('for (const [k, v] of Object.entries(sp))');
      const skipAt = src.indexOf("if (k === 'record') continue;");
      expect(loopAt, `${file}: the loop exists`).toBeGreaterThan(-1);
      expect(skipAt, `${file}: the skip is INSIDE the loop`).toBeGreaterThan(loopAt);
    }
  });

  it('the Balance record explanation describes every reset, not the August one', () => {
    for (const loc of LOCALES) {
      const cat = JSON.parse(read(`messages/${loc}.json`));
      const line = cat.admin.leaveLedgerArchive.noLeaveHistory as string;
      expect(typeof line, `${loc}`).toBe('string');
      // It may not claim anything about "either/both leave types" — that was true only of the
      // August Medical/Hospitalisation reset, and the newest capture covers every leave type.
      expect(line, `${loc}: no two-leave-type claim`).not.toMatch(/either leave type|both leave types/i);
    }
    expect(read('messages/en.json')).toContain('Every reset here kept the days people had actually taken');
  });
});
