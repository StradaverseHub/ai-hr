/**
 * r424 — how one import line's outcome reads, shared by the preview (a client component) and the import
 * log (a server page). Deliberately NOT a client module, so both sides can call `lineMessage`.
 */
import type { ImportLineView } from '@/packs/attendance/service';
import { formatDmy } from '@/lib/date-display';

export function lineMessage(
  t: (k: string, v?: Record<string, string>) => string,
  r: Pick<ImportLineView, 'result' | 'detail'>,
): string {
  if (r.result === 'duplicate' && r.detail) {
    const [d, tm, dir] = r.detail.split(' ');
    return t('result.duplicateOf', { detail: `${formatDmy(d)} ${tm}${dir ? ` ${t(`dirShort.${dir}`)}` : ''}` });
  }
  if (r.result === 'unknown_in_out_code' && r.detail) return t('result.unknownCodeOf', { detail: r.detail });
  return t(`result.${r.result}`);
}

export function ResultPill({ result, label }: { result: ImportLineView['result']; label: string }) {
  const cls =
    result === 'imported'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
      : result === 'duplicate'
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'
        : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400';
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
