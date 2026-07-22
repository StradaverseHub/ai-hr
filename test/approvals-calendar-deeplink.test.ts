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
import {
  APPROVAL_SECTION_ID,
  approvalRowDomId,
  buildApprovalAttentionHash,
  focusForCalendarPill,
  parseApprovalAttentionHash,
} from '../lib/approvals-focus';

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

// a34eedde: the composite attention hash — `<section>--<rowId>` — that lets arrival flash the exact
// approval row, plus its parser (first-double-hyphen split; section ids only ever carry SINGLE hyphens).
describe('buildApprovalAttentionHash / parseApprovalAttentionHash', () => {
  it('builds the bare section id when no rowId is present', () => {
    expect(buildApprovalAttentionHash('leave')).toBe('approvals-leave');
    expect(buildApprovalAttentionHash('leave', null)).toBe('approvals-leave');
    expect(buildApprovalAttentionHash('leaveCancellation')).toBe('approvals-leave-cancellation');
    expect(buildApprovalAttentionHash('leaveCancellation', null)).toBe(
      'approvals-leave-cancellation',
    );
  });

  it('builds `<section>--<rowId>` when a rowId is present, for both focuses', () => {
    expect(buildApprovalAttentionHash('leave', 'lr-1')).toBe('approvals-leave--lr-1');
    expect(buildApprovalAttentionHash('leaveCancellation', 'c-9')).toBe(
      'approvals-leave-cancellation--c-9',
    );
  });

  it('round-trips build → parse for both focuses', () => {
    expect(parseApprovalAttentionHash(buildApprovalAttentionHash('leave', 'lr-1'))).toEqual({
      sectionId: APPROVAL_SECTION_ID.leave,
      rowId: 'lr-1',
    });
    expect(
      parseApprovalAttentionHash(buildApprovalAttentionHash('leaveCancellation', 'c-9')),
    ).toEqual({ sectionId: APPROVAL_SECTION_ID.leaveCancellation, rowId: 'c-9' });
  });

  it('parses a section-only approvals-leave hash', () => {
    expect(parseApprovalAttentionHash('approvals-leave')).toEqual({
      sectionId: 'approvals-leave',
      rowId: null,
    });
  });

  it('parses section-only approvals-leave-cancellation (single hyphens only, no double hyphen)', () => {
    expect(parseApprovalAttentionHash('approvals-leave-cancellation')).toEqual({
      sectionId: 'approvals-leave-cancellation',
      rowId: null,
    });
  });

  it('splits approvals-leave-cancellation--<id> on the FIRST double hyphen (greedy-split refactor trap)', () => {
    // The exact strings a future greedy/last-occurrence split would break: the section prefix
    // itself carries hyphens, and the rowId may too.
    expect(parseApprovalAttentionHash('approvals-leave-cancellation--abc-def')).toEqual({
      sectionId: 'approvals-leave-cancellation',
      rowId: 'abc-def',
    });
    expect(parseApprovalAttentionHash('approvals-leave--abc-def')).toEqual({
      sectionId: 'approvals-leave',
      rowId: 'abc-def',
    });
  });

  it('an unknown section returns null', () => {
    expect(parseApprovalAttentionHash('approvals-claims')).toBeNull();
    expect(parseApprovalAttentionHash('approvals-claims--x')).toBeNull();
  });

  it('an empty string returns null', () => {
    expect(parseApprovalAttentionHash('')).toBeNull();
  });

  it('a trailing separator with no rowId parses as section-only', () => {
    expect(parseApprovalAttentionHash('approvals-leave--')).toEqual({
      sectionId: 'approvals-leave',
      rowId: null,
    });
  });
});

// a34eedde: the pill href embeds the row the approver will decide — the leave id for a pending pill,
// the pending CANCELLATION id for an approved-with-pending-cancellation pill (that section's rows are
// keyed by cancellation id, not the parent leave id). Mirrors the composition in planned-absences.tsx.
describe('pill href composition (focusForCalendarPill + buildApprovalAttentionHash)', () => {
  const hrefFor = (l: { id: string; status: string; pendingCancellationId?: string | null }) => {
    const focus = focusForCalendarPill(l);
    return focus
      ? `/approvals#${buildApprovalAttentionHash(
          focus,
          focus === 'leaveCancellation' ? l.pendingCancellationId : l.id,
        )}`
      : null;
  };

  it('a pending pill embeds the leave request id', () => {
    expect(hrefFor({ id: 'lr-1', status: 'pending', pendingCancellationId: null })).toBe(
      '/approvals#approvals-leave--lr-1',
    );
  });

  it('an approved pill with a pending cancellation embeds the CANCELLATION id', () => {
    expect(hrefFor({ id: 'lr-1', status: 'approved', pendingCancellationId: 'c-9' })).toBe(
      '/approvals#approvals-leave-cancellation--c-9',
    );
  });

  it('a plain approved pill gets no href', () => {
    expect(hrefFor({ id: 'lr-1', status: 'approved', pendingCancellationId: null })).toBeNull();
  });
});

describe('drift guards (source assertions)', () => {
  it('the approvals page anchors both sections with ids built from APPROVAL_SECTION_ID', () => {
    const src = read('app/approvals/page.tsx');
    // a34eedde widened this import: the page now also stamps per-row ids from the same module.
    expect(src).toContain("import { APPROVAL_SECTION_ID, approvalRowDomId } from '@/lib/approvals-focus'");
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

  it('the calendar pill href is built from the shared buildApprovalAttentionHash import, never hand-rolled', () => {
    const src = read('components/planned-absences.tsx');
    expect(src).toContain("import { buildApprovalAttentionHash, focusForCalendarPill } from '@/lib/approvals-focus'");
    expect(src).toContain('`/approvals#${buildApprovalAttentionHash(');
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

  // ── a34eedde: whole-pill click-through + row flash ──────────────────────────────────────────

  it('the grid stretches the approval Link over the pill with an inset hover ring', () => {
    const src = read('components/planned-absences-grid.tsx');
    // The ::after overlay makes the whole pill the anchor's click target…
    expect(src).toContain('after:absolute');
    expect(src).toContain('after:inset-0');
    // …and the hover affordance is the pinned inset ring (overflow-hidden clips an outset one).
    expect(src).toContain('hover:after:ring-2');
    expect(src).toContain('after:ring-inset');
    // No wrapper onClick/router navigation may reappear — the anchor IS the navigation.
    expect(src.includes('useRouter')).toBe(false);
  });

  it('all three dialog trigger buttons are lifted above the stretched overlay', () => {
    const src = read('components/planned-absences-grid.tsx');
    // CancelDatesDialog + AdminCancelLeaveDialog + CancelLeaveDialog triggers: positioned + auto-z
    // above the (non-lifted) overlay so their clicks are never stolen by the link.
    expect(src.match(/relative z-10 grid size-4/g)?.length).toBe(3);
  });

  it('the approvals page stamps approvalRowDomId ids on the rows of BOTH tables', () => {
    const src = read('app/approvals/page.tsx');
    expect(src.match(/id=\{approvalRowDomId\(/g)?.length).toBe(2);
  });

  it('the arrival island parses the hash through the shared parser', () => {
    const src = read('app/approvals/attention-on-arrival.tsx');
    expect(src).toContain('parseApprovalAttentionHash');
    expect(src).toContain('approvalRowDomId(');
    expect(src).toContain('approvals-row-attention');
  });

  it('the row-attention CSS class exists with a STATIC tint base (reduce-motion safe) plus a flash', () => {
    const css = read('app/globals.css');
    expect(css).toContain('.approvals-row-attention');
    expect(css).toContain('@keyframes approvals-row-attention-flash');
    // Mirror of the section-class scan: the static tint must not live inside a reduce-motion block.
    const reduceBlocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    for (const block of reduceBlocks) {
      const inner = block.slice(0, block.indexOf('}\n}') + 3);
      expect(inner.includes('approvals-row-attention')).toBe(false);
    }
  });
});
