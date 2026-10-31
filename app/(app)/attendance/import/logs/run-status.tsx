import type { ClockingImportStatus } from '@/packs/attendance/service';
import { StatusWord } from '@/components/ui/status-word';

/** r424 — the derived import status as a pill. Colour keys off the status, text is translated by the caller. */
export function RunStatusPill({ status, label }: { status: ClockingImportStatus; label: string }) {
  const cls =
    status === 'successful'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
      : status === 'completed_with_errors'
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'
        : status === 'failed'
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400'
          : 'border border-border bg-muted text-muted-foreground';
  // r427 — Classic's pill string is unchanged; Monolith writes it as a status word.
  const tone = status === 'successful' ? 'ink' : status === 'no_records' ? 'mid' : 'signal';
  return (
    <StatusWord tone={tone} className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </StatusWord>
  );
}
