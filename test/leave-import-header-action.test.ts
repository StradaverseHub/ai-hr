/**
 * Move Import Function as Action Button Instead of Standalone Section (R61 · feedback e8f2398f).
 *
 * The Entitlements tab used to render a whole standalone Card near the page bottom whose only job was
 * holding a link to /admin/leave/import. e8f2398f put a "+ Import" btnPrimary Link into the PageHeader
 * actions slot and removed the signpost Card.
 *
 * ── 10b59703 (r266) — UPDATED, NOT LOOSENED ─────────────────────────────────────────────────────────
 *
 * The reporter's instruction for that round was that the left submenu IS the navigation and that each
 * function has exactly one home. Import loads balance MOVEMENTS (opening balances, carry-forward,
 * ad-hoc credits — leave_ledger rows; NOT leave records, which are r362's Leave History Data Import),
 * so it is a tab of Leave Adjustments now, and
 * the + Import button left the Entitlements header with the three links beside it. e8f2398f's real
 * property — "the way into the importer is ONE deliberate entry, never a standalone signpost Card" —
 * still holds and is what is pinned: one entry in the module (the tab), zero on the leave type screen,
 * no signpost Card anywhere, and the `importAction` label pruned with the button that read it.
 *
 * DB-free source guard (the suite has no DOM runner): composition asserted statically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const LEAVE_TYPE_PAGES = ['/app/admin/leave-config/types/page.tsx'] as const;

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
// Keys of the removed standalone Card (e8f2398f) and of the removed header button (10b59703) — pruned everywhere.
const PRUNED_KEYS = ['importTitle', 'importHelp', 'importLink', 'importAction'] as const;

describe('e8f2398f → 10b59703: Import has exactly one home, the Leave Adjustments tab', () => {
  it('the importer is the second tab of the Leave Adjustments row, and appears in no other group', () => {
    const adjustments = LEAVE_CONFIG_MAP.find((g) => g.id === 'adjustments')!;
    // 7f69bd71 — second, not third: the Balance record left the row for the Reset records sub-screen.
    expect(adjustments.items.map((i) => i.id)).toEqual(['adjustments', 'importLeaveData']);
    expect(adjustments.items.find((i) => i.id === 'importLeaveData')!.href).toBe('/admin/leave-config/import');
    const elsewhere = LEAVE_CONFIG_MAP.filter((g) => g.id !== 'adjustments').flatMap((g) => g.items).map((i) => i.id);
    expect(elsewhere).not.toContain('importLeaveData');
  });

  it.each(LEAVE_TYPE_PAGES)('%s has no importer entry left — not in the header, not as a section, not as a literal', (rel) => {
    const page = read(rel);
    const header = page.match(/<PageHeader[\s\S]*?\/>/)?.[0] ?? '';
    // 5ca446db (r269) — UPDATED, NOT LOOSENED. `expect(header).toMatch(/actions=\{/)` stood here as the
    // non-vacuity anchor: it proved the slice really was a header with a slot in it, so "no importer in the
    // header" could not pass on an empty match. The slot itself is gone now — its last occupant, r242's
    // Employee Balances link, became the Leave Config fly-out's sixth row — so the anchor moves onto
    // something the header still has, and the absence of the slot is asserted rather than its presence.
    expect(header, 'the slice must really be the header element').toContain('title={header.title}');
    expect(header, 'the header opens nothing at all now').not.toMatch(/actions=\{/);
    expect(header).not.toContain("leaveConfigScreenHref('importLeaveData')");
    expect(header).not.toContain('importAction');
    for (const key of PRUNED_KEYS) expect(page.includes(key)).toBe(false);
    expect(page.match(/href=\{leaveConfigScreenHref\('importLeaveData'\)\}/g) ?? []).toHaveLength(0);
    expect(page.match(/href="\/admin\/leave(-config)?\/import"/g) ?? []).toHaveLength(0);
  });

  it('the importer page reads its header through the row helper, so its heading is "Leave Adjustments"', () => {
    const page = read('/app/admin/leave-config/import/page.tsx');
    expect(page).toContain("leaveConfigPageHeader('importLeaveData')");
    expect(page).toContain('<LeaveConfigMap current="importLeaveData" />');
    // The back-link that pointed at the leave type screen is gone with the header button that fed it.
    expect(page).not.toContain('back={{');
    expect(page).not.toContain("t('backLabel')");
  });

  it('leaves the import flow itself untouched — the importer page still exists, at its address', () => {
    expect(read('/app/admin/leave-config/import/page.tsx')).toContain('<LeaveLedgerImport />');
    // And the old address still ANSWERS: it is a redirect stub, never deleted, because the reporter's
    // bookmarks are the reason the stubs exist (migration order → Round 5/6).
    const stub = read('/app/admin/leave/import/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/import');
  });
});

describe('e8f2398f → 10b59703: i18n — the card keys AND the header-button label are pruned in all 6 locales', () => {
  for (const locale of LOCALES) {
    it(`${locale}.json carries none of the retired import keys`, () => {
      const leave = JSON.parse(read(`/messages/${locale}.json`)).admin.leave as Record<string, unknown>;
      for (const key of PRUNED_KEYS) expect(leave, `${locale}: ${key} should be pruned`).not.toHaveProperty(key);
      // History guard: a QW-wave commit once left an orphaned duplicate "importAction" line behind —
      // JSON.parse silently keeps the LAST one, so assert the raw file carries the key nowhere at all.
      const raw = read(`/messages/${locale}.json`);
      expect(raw.match(/"importAction"/g) ?? [], `${locale}: importAction must be gone`).toHaveLength(0);
      // …while the tab's own label, which replaced it as the way in, is present.
      const item = JSON.parse(raw).admin.leaveConfigMap.item as Record<string, string>;
      expect(item.importLeaveData.trim().length).toBeGreaterThan(0);
    });
  }
});
