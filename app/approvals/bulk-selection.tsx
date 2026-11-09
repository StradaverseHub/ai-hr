'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { bulkDecideAction, selectPendingClaimsAction } from './actions';
import {
  bulkRowKey,
  computeBulkBreakdown,
  type BulkCategory,
  type BulkDecideType,
  type BulkRow,
} from '@/lib/approvals-bulk';

/**
 * Bulk-approval selection island (feedback fb99474b). A single 'use client' provider wraps the whole
 * approvals page content; the per-row checkboxes, the per-section + global "select all", and the sticky
 * action bar all read/write ONE selection Set through context. Selection is keyed by (type,id) via
 * bulkRowKey — index-independent, so a re-sort (item 09cda965) or reload keeps the picks. The server page
 * passes ONLY the actionable pending rows (self rows / out-of-authority steps are never selectable), and
 * the bulk server action re-checks every id through the normal decide* path (assertCanDecide), so the UI
 * filter is convenience, not the security boundary. Uppercase exports only — the server page renders them
 * as JSX (never calls them), satisfying the RSC-boundary guard; pure helpers live in lib/approvals-bulk.ts.
 */

type Ctx = {
  rows: BulkRow[];
  selected: Set<string>;
  toggle: (key: string) => void;
  selectAll: (type: BulkDecideType | undefined, on: boolean) => void;
  claimsUnloaded: boolean;
  selecting: boolean;
  clearAll: () => void;
  selectedRows: BulkRow[];
};

const BulkCtx = createContext<Ctx | null>(null);
const isClaimKey = (key: string) => key.startsWith('claim:');

function useBulk(): Ctx {
  const ctx = useContext(BulkCtx);
  if (!ctx) throw new Error('Bulk selection components must render inside <BulkSelectionProvider>');
  return ctx;
}

export function BulkSelectionProvider({
  rows,
  sort,
  category,
  claimSelectionScope,
  claimsOutsidePage = false,
  children,
}: {
  rows: BulkRow[];
  /** Current ?sort= value — threaded into the bulk POST so the redirect preserves the chosen order. */
  sort?: string;
  /** Current ?category= value (2dec6406) — threaded exactly like sort so the redirect keeps the filter. */
  category?: string;
  claimSelectionScope?: string;
  claimsOutsidePage?: boolean;
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [allClaims, setAllClaims] = useState<BulkRow[]>();
  const [selectionError, setSelectionError] = useState(false);
  const [selecting, startSelection] = useTransition();
  const t = useTranslations('approvals');

  const availableRows = useMemo(() => {
    if (!allClaims) return rows;
    const claimKeys = new Set(allClaims.map(bulkRowKey));
    return [...rows.filter(row => !claimKeys.has(bulkRowKey(row))), ...allClaims];
  }, [rows, allClaims]);
  const validKeys = useMemo(() => new Set(availableRows.map(bulkRowKey)), [availableRows]);
  useEffect(() => {
    setSelected(prev => {
      // Claims selected on another page retain only their IDs. The service
      // rechecks every ID when a decision is submitted.
      const next = new Set([...prev].filter(key =>
        validKeys.has(key) || (claimSelectionScope !== undefined && isClaimKey(key))
      ));
      return next.size === prev.size ? prev : next;
    });
  }, [validKeys, claimSelectionScope]);

  const value = useMemo<Ctx>(() => {
    const toggle = (key: string) =>
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    const claimsUnloaded = claimsOutsidePage && allClaims === undefined;
    const selectAll = (type: BulkDecideType | undefined, on: boolean) => {
      if (selecting) return;
      const matches = (row: BulkRow) => type === undefined || row.type === type;
      const apply = (selectionRows: BulkRow[], replaceClaims = false) => setSelected(prev => {
        const resetClaims = replaceClaims || (!on && (type === undefined || type === 'claim'));
        const next = new Set(resetClaims ? [...prev].filter(key => !isClaimKey(key)) : prev);
        for (const row of selectionRows.filter(matches)) {
          const key = bulkRowKey(row);
          if (on) next.add(key);
          else next.delete(key);
        }
        return next;
      });
      if (!on || !claimsOutsidePage || claimSelectionScope === undefined || (type !== undefined && type !== 'claim')) {
        apply(availableRows);
        return;
      }
      setSelectionError(false);
      startSelection(async () => {
        try {
          const result = await selectPendingClaimsAction(claimSelectionScope);
          if (!result.ok) {
            setSelectionError(true);
            return;
          }
          const capturedClaims = result.ids.map(id => ({ id, type: 'claim' as const, category: 'claim' as const }));
          setAllClaims(capturedClaims);
          apply([...availableRows.filter(row => row.type !== 'claim'), ...capturedClaims], true);
        } catch {
          setSelectionError(true);
        }
      });
    };
    const clearAll = () => {
      setSelected(new Set());
      setAllClaims(undefined);
      setSelectionError(false);
    };
    const selectedRows = availableRows.filter(row => selected.has(bulkRowKey(row)));
    if (claimSelectionScope !== undefined) {
      for (const key of selected) {
        if (isClaimKey(key) && !validKeys.has(key)) {
          selectedRows.push({id:key.slice('claim:'.length),type:'claim',category:'claim'});
        }
      }
    }
    return { rows: availableRows, selected, toggle, selectAll, clearAll, selectedRows, claimsUnloaded, selecting };
  }, [availableRows, validKeys, selected, allClaims, claimsOutsidePage, claimSelectionScope, selecting]);

  return (
    <BulkCtx.Provider value={value}>
      {selectionError && <p role="alert" className="mb-2 text-sm text-destructive">{t('bulkSelectionUnavailable')}</p>}
      {children}
      <BulkActionBar sort={sort} category={category} />
    </BulkCtx.Provider>
  );
}

/** Tri-state checkbox (checked / unchecked / indeterminate). */
function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={ariaLabel}
      className="size-4 cursor-pointer rounded border-border accent-primary"
    />
  );
}

/** Per-row selection checkbox (rendered in each actionable pending row). */
export function BulkRowCheckbox({ id, type }: { id: string; type: BulkDecideType }) {
  const { selected, toggle, selecting } = useBulk();
  const t = useTranslations('approvals');
  const key = bulkRowKey({ type, id });
  return (
    <TriCheckbox checked={selected.has(key)} disabled={selecting} onChange={() => toggle(key)} ariaLabel={t('bulkSelectRow')} />
  );
}

/** Per-section header select-all: toggles every actionable row of one type. */
export function BulkSectionSelectAll({ type }: { type: BulkDecideType }) {
  const { rows, selected, selectAll, claimsUnloaded, selecting } = useBulk();
  const t = useTranslations('approvals');
  const keys = useMemo(() => rows.filter((r) => r.type === type).map(bulkRowKey), [rows, type]);
  const unloaded = type === 'claim' && claimsUnloaded;
  if (keys.length === 0 && !unloaded) return null;
  const selectedCount = keys.filter((k) => selected.has(k)).length;
  const allOn = !unloaded && selectedCount === keys.length;
  return (
    <TriCheckbox
      checked={allOn}
      indeterminate={selectedCount > 0}
      disabled={selecting}
      onChange={() => selectAll(type, !allOn)}
      ariaLabel={t('bulkSelectAll')}
    />
  );
}

/** Global "Select all" across every section (rendered in the page header actions). Hidden when there is
 *  nothing selectable, so an empty queue shows no dangling control. */
export function BulkSelectAllToggle() {
  const { rows, selected, selectAll, clearAll, claimsUnloaded, selecting } = useBulk();
  const t = useTranslations('approvals');
  const allKeys = useMemo(() => rows.map(bulkRowKey), [rows]);
  if (allKeys.length === 0 && !claimsUnloaded) return null;
  const selectedCount = allKeys.filter((k) => selected.has(k)).length;
  const allOn = !claimsUnloaded && selectedCount === allKeys.length;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <TriCheckbox
        checked={allOn}
        indeterminate={selectedCount > 0}
        disabled={selecting}
        onChange={() => (allOn ? clearAll() : selectAll(undefined, true))}
        ariaLabel={t('bulkSelectAll')}
      />
      <span className="whitespace-nowrap">{t('bulkSelectAll')}</span>
    </label>
  );
}

const CATEGORY_LABEL_KEY: Record<BulkCategory, string> = {
  leave: 'bulkBreakdownLeave',
  leaveCancellation: 'bulkBreakdownLeaveCancellation',
  attendance: 'bulkBreakdownAttendance',
  overtime: 'bulkBreakdownOvertime',
  claim: 'bulkBreakdownClaim',
};

/** Sticky bar + confirmation dialog. Rendered once by the provider; returns null when nothing is selected. */
function BulkActionBar({ sort, category }: { sort?: string; category?: string }) {
  const { selectedRows, clearAll, selecting } = useBulk();
  const t = useTranslations('approvals');
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [reason, setReason] = useState('');

  const count = selectedRows.length;
  const breakdown = useMemo(() => computeBulkBreakdown(selectedRows), [selectedRows]);
  // Snapshot the exact items to POST at the moment the dialog opens — read from current selection.
  const items = useMemo(
    () => selectedRows.map((r) => ({ type: r.type, id: r.id, ...(r.expectedStageIndex != null ? {expectedStageIndex:r.expectedStageIndex} : {}), ...(r.expectedParticipantSlot ? {expectedParticipantSlot:r.expectedParticipantSlot} : {}), ...(r.recommendationRecordId ? { recommendationRecordId: r.recommendationRecordId } : {}) })),
    [selectedRows],
  );

  const closeDialog = () => {
    setDecision(null);
    setReason('');
  };
  const rejecting = decision === 'rejected';
  const missingReason = rejecting && !reason.trim();

  if (count === 0) return null;

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4">
        <div className="flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border border-border bg-popover/95 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium">{t('bulkSelected', { count })}</span>
            <button
              type="button"
              disabled={selecting}
              onClick={clearAll}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {t('bulkClear')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={selecting} onClick={() => setDecision('approved')}>
              {t('bulkApproveSelected')}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={selecting} onClick={() => setDecision('rejected')}>
              {t('bulkRejectSelected')}
            </Button>
          </div>
        </div>
      </div>

      <Dialog.Root open={decision !== null} onOpenChange={(next) => (!next ? closeDialog() : void 0)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
            <Dialog.Title className="text-base font-semibold">
              {rejecting ? t('bulkConfirmRejectTitle') : t('bulkConfirmApproveTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">
              {rejecting ? t('bulkConfirmRejectBody', { count }) : t('bulkConfirmApproveBody', { count })}
            </Dialog.Description>

            <ul className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              {breakdown.map((b) => (
                <li key={b.category} className="flex justify-between">
                  <span className="text-muted-foreground">{t(CATEGORY_LABEL_KEY[b.category])}</span>
                  <span className="tabular-nums font-medium">{b.count}</span>
                </li>
              ))}
            </ul>

            {rejecting && (
              <label className="mt-3 block text-xs text-muted-foreground">
                {t('bulkRejectReasonLabel')}
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  required
                  placeholder={t('bulkRejectReasonLabel')}
                  className={`${inputCls} mt-1 w-full resize-none text-sm`}
                />
              </label>
            )}

            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">{t('bulkExcludedNote')}</p>

            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={closeDialog}>
                {t('bulkCancel')}
              </Button>
              {/* One POST for the whole batch; the server action dispatches each id to its decide* service
                  (per-item try/catch + own transaction) and redirects with the N-approved/M-skipped toast.
                  Clear the selection + close as it posts (same optimistic pattern as the per-date dialog). */}
              <form
                action={bulkDecideAction}
                onSubmit={() => {
                  clearAll();
                  closeDialog();
                }}
              >
                <input type="hidden" name="items" value={JSON.stringify(items)} />
                <input type="hidden" name="decision" value={decision ?? 'approved'} />
                <input type="hidden" name="rejectReason" value={reason} />
                <input type="hidden" name="sort" value={sort ?? ''} />
                <input type="hidden" name="category" value={category ?? ''} />
                <Button type="submit" size="sm" disabled={missingReason}>
                  {t('bulkConfirm')}
                </Button>
              </form>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
