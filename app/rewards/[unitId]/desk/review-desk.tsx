'use client';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RewardFlag } from '@/packs/rewards/model';
import type { DeskRow, DeskSummary, DeskTotals } from './desk-model';
import { saveRewardCell, type RewardCellField, type RewardCellResult } from '../../actions';

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
type Pending = { entryId: string; field: RewardCellField; value: string };
type DeskState = {
  unitId: string; revision: number; summary: DeskSummary; totals: DeskTotals; flags: readonly RewardFlag[];
  rows: Readonly<Record<string, DeskRow>>; saveState: SaveState; stale: boolean; error: string;
  flagsOpen: boolean; setFlagsOpen: (open: boolean) => void;
  save: (entryId: string, field: RewardCellField, value: string) => Promise<RewardCellResult>;
  retry: () => void;
};
const DeskContext = createContext<DeskState | null>(null);
export function useReviewDesk() {
  const value = useContext(DeskContext);
  if (!value) throw new Error('The review desk is not available here.');
  return value;
}
export function useOptionalReviewDesk() { return useContext(DeskContext); }

/**
 * 37f82412 — the editable Review tab's shared state. Saves run one at a time, each with the newest revision
 * returned by the previous save, because every save moves the review's revision on. The server returns the
 * recalculated row, tiles, Total row and flags; nothing is recalculated here. A save refused because the
 * review changed elsewhere sets `stale`, which shows a Reload banner instead of an error page.
 */
export function ReviewDeskProvider({ unitId, revision: initialRevision, summary: initialSummary, totals: initialTotals, flags: initialFlags, rows: initialRows, filters, children }: {
  unitId: string; revision: number; summary: DeskSummary; totals: DeskTotals; flags: readonly RewardFlag[]; rows: readonly DeskRow[];
  filters: Record<string, string>; children: ReactNode;
}) {
  const [revision, setRevision] = useState(initialRevision);
  const [summary, setSummary] = useState(initialSummary);
  const [totals, setTotals] = useState(initialTotals);
  const [flags, setFlags] = useState(initialFlags);
  const [rows, setRows] = useState<Record<string, DeskRow>>(() => Object.fromEntries(initialRows.map(row => [row.id, row])));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [flagsOpen, setFlagsOpen] = useState(false);
  const latest = useRef(initialRevision);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const failed = useRef<Pending | null>(null);

  const save = useCallback((entryId: string, field: RewardCellField, value: string) => {
    const run = queue.current.then(async (): Promise<RewardCellResult> => {
      setSaveState('saving'); setError('');
      let result: RewardCellResult;
      try { result = await saveRewardCell(unitId, latest.current, entryId, field, value, filters); }
      catch { result = { ok: false, stale: false, error: '' }; }
      if (result.ok) {
        latest.current = result.revision; failed.current = null;
        setRevision(result.revision); setSummary(result.summary); setTotals(result.totals); setFlags(result.flags);
        const row = result.row;
        if (row) setRows(previous => previous[row.id] ? { ...previous, [row.id]: row } : previous);
        setSaveState('saved');
      } else {
        failed.current = result.stale ? null : { entryId, field, value };
        if (result.stale) setStale(true);
        setError(result.error); setSaveState('failed');
      }
      return result;
    });
    queue.current = run.catch(() => undefined);
    return run;
  }, [unitId, filters]);
  const retry = useCallback(() => { const last = failed.current; if (last) void save(last.entryId, last.field, last.value); }, [save]);
  const value = useMemo(() => ({ unitId, revision, summary, totals, flags, rows, saveState, stale, error, flagsOpen, setFlagsOpen, save, retry }),
    [unitId, revision, summary, totals, flags, rows, saveState, stale, error, flagsOpen, save, retry]);
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}
