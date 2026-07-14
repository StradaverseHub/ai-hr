'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from '@/components/ui';
import { bulkDecideAction } from './actions';
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
  setMany: (keys: string[], on: boolean) => void;
  clearAll: () => void;
  selectedRows: BulkRow[];
};

const BulkCtx = createContext<Ctx | null>(null);

function useBulk(): Ctx {
  const ctx = useContext(BulkCtx);
  if (!ctx) throw new Error('Bulk selection components must render inside <BulkSelectionProvider>');
  return ctx;
}

export function BulkSelectionProvider({
  rows,
  sort,
  children,
}: {
  rows: BulkRow[];
  /** Current ?sort= value — threaded into the bulk POST so the redirect preserves the chosen order. */
  sort?: string;
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // A row that disappears from the queue (already decided elsewhere, filtered out) must not linger in the
  // selection. Reconcile whenever the row set changes so counts/breakdown never reference a stale id.
  const validKeys = useMemo(() => new Set(rows.map(bulkRowKey)), [rows]);
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (validKeys.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [validKeys]);

  const value = useMemo<Ctx>(() => {
    const toggle = (key: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    const setMany = (keys: string[], on: boolean) =>
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of keys) {
          if (on) next.add(k);
          else next.delete(k);
        }
        return next;
      });
    const clearAll = () => setSelected(new Set());
    const selectedRows = rows.filter((r) => selected.has(bulkRowKey(r)));
    return { rows, selected, toggle, setMany, clearAll, selectedRows };
  }, [rows, selected]);

  return (
    <BulkCtx.Provider value={value}>
      {children}
      <BulkActionBar sort={sort} />
    </BulkCtx.Provider>
  );
}

/** Tri-state checkbox (checked / unchecked / indeterminate). */
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
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
      onChange={onChange}
      aria-label={ariaLabel}
      className="size-4 cursor-pointer rounded border-border accent-primary"
    />
  );
}

/** Per-row selection checkbox (rendered in each actionable pending row). */
export function BulkRowCheckbox({ id, type }: { id: string; type: BulkDecideType }) {
  const { selected, toggle } = useBulk();
  const t = useTranslations('approvals');
  const key = bulkRowKey({ type, id });
  return (
    <TriCheckbox checked={selected.has(key)} onChange={() => toggle(key)} ariaLabel={t('bulkSelectRow')} />
  );
}

/** Per-section header select-all: toggles every actionable row of one type. */
export function BulkSectionSelectAll({ type }: { type: BulkDecideType }) {
  const { rows, selected, setMany } = useBulk();
  const t = useTranslations('approvals');
  const keys = useMemo(() => rows.filter((r) => r.type === type).map(bulkRowKey), [rows, type]);
  if (keys.length === 0) return null;
  const selectedCount = keys.filter((k) => selected.has(k)).length;
  const allOn = selectedCount === keys.length;
  return (
    <TriCheckbox
      checked={allOn}
      indeterminate={selectedCount > 0}
      onChange={() => setMany(keys, !allOn)}
      ariaLabel={t('bulkSelectAll')}
    />
  );
}

/** Global "Select all" across every section (rendered in the page header actions). Hidden when there is
 *  nothing selectable, so an empty queue shows no dangling control. */
export function BulkSelectAllToggle() {
  const { rows, selected, setMany, clearAll } = useBulk();
  const t = useTranslations('approvals');
  const allKeys = useMemo(() => rows.map(bulkRowKey), [rows]);
  if (allKeys.length === 0) return null;
  const selectedCount = allKeys.filter((k) => selected.has(k)).length;
  const allOn = selectedCount === allKeys.length;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <TriCheckbox
        checked={allOn}
        indeterminate={selectedCount > 0}
        onChange={() => (allOn ? clearAll() : setMany(allKeys, true))}
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
  travel: 'bulkBreakdownTravel',
};

/** Sticky bar + confirmation dialog. Rendered once by the provider; returns null when nothing is selected. */
function BulkActionBar({ sort }: { sort?: string }) {
  const { selectedRows, clearAll } = useBulk();
  const t = useTranslations('approvals');
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [reason, setReason] = useState('');

  const count = selectedRows.length;
  const breakdown = useMemo(() => computeBulkBreakdown(selectedRows), [selectedRows]);
  // Snapshot the exact items to POST at the moment the dialog opens — read from current selection.
  const items = useMemo(
    () => selectedRows.map((r) => ({ type: r.type, id: r.id })),
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
              onClick={clearAll}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {t('bulkClear')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => setDecision('approved')}>
              {t('bulkApproveSelected')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDecision('rejected')}>
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
