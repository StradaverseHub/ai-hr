/**
 * Leave Calendar → Approvals deep-link (item 8cb7b089).
 *
 * Pure — no database, no harness (modelled on test/approvals-sort.test.ts). Two halves:
 *  1. focusForCalendarPill routing, including the precedence case the read layer makes representable
 *     (a PENDING row that ALSO carries a pending cancellation belongs in the Leave Requests section,
 *     because that is where the Approvals page actually shows it).
 *  2. readFileSync drift guards (the convention of test/dashboard-save-confirm.test.ts): there is no
 *     component-render harness in this repo, so these source assertions carry the weight — renaming a
 *     section id or hand-rolling the pill href would otherwise degrade the feature to a silent no-op
 *     that the arrival island's missing-element guard swallows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APPROVAL_SECTION_ID, focusForCalendarPill } from '../lib/approvals-focus';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('focusForCalendarPill', () => {
  it('a pending row routes to the Leave Requests section', () => {
    expect(focusForCalendarPill({ status: 'pending', pendingCancellationId: null })).toBe('leave');
  });

  it('an approved row with a pending cancellation routes to the Leave Cancellation section', () => {
    expect(focusForCalendarPill({ status: 'approved', pendingCancellationId: 'c1' })).toBe(
      'leaveCancellation',
    );
  });

  it('a plain approved row routes nowhere', () => {
    expect(focusForCalendarPill({ status: 'approved', pendingCancellationId: null })).toBeNull();
    expect(focusForCalendarPill({ status: 'approved' })).toBeNull();
  });

  it('a PENDING row that also carries a pending cancellation routes to Leave Requests (where the page shows it)', () => {
    expect(focusForCalendarPill({ status: 'pending', pendingCancellationId: 'c1' })).toBe('leave');
  });

  it('other statuses route nowhere', () => {
    expect(focusForCalendarPill({ status: 'cancelled', pendingCancellationId: null })).toBeNull();
    expect(focusForCalendarPill({ status: 'rejected' })).toBeNull();
  });
});

describe('drift guards (source assertions)', () => {
  it('the approvals page anchors both sections with ids built from APPROVAL_SECTION_ID', () => {
    const src = read('app/approvals/page.tsx');
    expect(src).toContain("import { APPROVAL_SECTION_ID } from '@/lib/approvals-focus'");
    expect(src).toContain('id={APPROVAL_SECTION_ID.leave}');
    expect(src).toContain('id={APPROVAL_SECTION_ID.leaveCancellation}');
    // The two ids stay what shipped bookmarks/hashes expect.
    expect(APPROVAL_SECTION_ID.leave).toBe('approvals-leave');
    expect(APPROVAL_SECTION_ID.leaveCancellation).toBe('approvals-leave-cancellation');
    // The attention island is rendered on the page, and the onboarding-tour hook survives untouched.
    expect(src).toContain('<AttentionOnArrival />');
    expect(src).toContain('data-tour="approvals-leave"');
  });

  it('the approvals page narrows listLeaveRequests to PENDING (the 200-row-cap pre-fix, step 1)', () => {
    const src = read('app/approvals/page.tsx');
    expect(src).toMatch(/listLeaveRequests\(s,\s*scopeIds,\s*200,\s*\{\s*status:\s*'pending'\s*\}\)/);
  });

  it('/leave keeps its pinned call shape (step 1 must not disturb it)', () => {
    const src = read('app/leave/page.tsx');
    expect(src).toContain('listLeaveRequests(session, scopeIds)');
  });

  it('the calendar pill href is built from the APPROVAL_SECTION_ID import, never hand-rolled', () => {
    const src = read('components/planned-absences.tsx');
    expect(src).toContain("import { APPROVAL_SECTION_ID, focusForCalendarPill } from '@/lib/approvals-focus'");
    expect(src).toContain('`/approvals#${APPROVAL_SECTION_ID[');
    // The translation key the server half resolves matches the key shipped in the catalog (this file
    // pulls TWO namespaces, so i18n-coverage check C skips it — assert the name here instead).
    expect(src).toContain("tLeave('approvalPillAffordanceLabel')");
  });

  it('the grid renders the arrow as a non-prefetching link that leaves scrolling to the island', () => {
    const src = read('components/planned-absences-grid.tsx');
    expect(src).toContain('l.approvalHref');
    expect(src).toContain('prefetch={false}');
    expect(src).toContain('scroll={false}');
  });

  it('every locale carries leave.approvalPillAffordanceLabel', () => {
    for (const loc of LOCALES) {
      const d = JSON.parse(fs.readFileSync(path.join(root, 'messages', `${loc}.json`), 'utf8'));
      expect(d.leave.approvalPillAffordanceLabel, `${loc} leave.approvalPillAffordanceLabel`).toBeTruthy();
    }
  });

  it('the attention CSS class exists with a STATIC outline base (reduce-motion safe) plus a pulse', () => {
    const css = read('app/globals.css');
    expect(css).toContain('.approvals-attention');
    expect(css).toContain('@keyframes approvals-attention-pulse');
    // The base outline must not live inside a reduce-motion block (the static signal IS the fallback).
    const reduceBlocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    for (const block of reduceBlocks) {
      const inner = block.slice(0, block.indexOf('}\n}') + 3);
      expect(inner.includes('approvals-attention')).toBe(false);
    }
  });
});
