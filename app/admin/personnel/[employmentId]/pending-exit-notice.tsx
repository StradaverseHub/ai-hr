// 7da649d3 — the Employment tab's notice for a scheduled Termination or Resignation, and the provenance line
// under each Resignation Information date. Pure presentation over the movement projection (core/movement.ts):
// the exit dates are written when the movement is saved, while terminated_on and the assignment and
// reporting-line closure wait for the effective date.
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDmy } from '@/lib/date-display';
import type { ResignationInformation } from '@/core/movement';

export type PendingExit = {
  id: string;
  /** The movement type's own label (a tenant's Termination type keeps its name). */
  label: string;
  behaviour: 'termination' | 'resignation';
  effectiveDate: string;
  lastWorkingDate: string | null;
};

export function PendingExitNotice({ exit }: { exit: PendingExit }) {
  const t = useTranslations('people.detail');
  const lastDay = exit.lastWorkingDate ? formatDmy(exit.lastWorkingDate) : null;
  return (
    <section
      aria-label={t('employmentInfo.pendingExitTitle', { kind: exit.label })}
      data-pending-exit={exit.id}
      className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground"
    >
      <p className="font-medium">{t('employmentInfo.pendingExitTitle', { kind: exit.label })}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
        {lastDay ? (
          <li>
            {exit.behaviour === 'termination'
              ? t('employmentInfo.pendingExitLastDay', { lastDay, date: formatDmy(exit.effectiveDate) })
              : t('employmentInfo.pendingExitLastDayOnly', { lastDay })}
          </li>
        ) : null}
        {exit.behaviour === 'termination' ? <li>{t('employmentInfo.pendingExitPlacement')}</li> : null}
        {lastDay ? <li>{t('employmentInfo.pendingExitPayroll')}</li> : null}
      </ul>
    </section>
  );
}

type ResignationSource = ResignationInformation[keyof ResignationInformation]['source'];

export function ResignationSourceNote({ source, href }: { source: ResignationSource | undefined; href: (movementId: string) => string }) {
  const t = useTranslations('people.detail');
  if (source?.kind === 'movement') {
    return (
      <Link className="text-xs text-primary underline" href={href(source.movementId)}>
        {t('resignationInformation.movementSource')} · {formatDmy(source.effectiveDate)}
      </Link>
    );
  }
  if (source?.kind === 'scheduled') {
    return (
      <Link className="text-xs text-primary underline" href={href(source.movementId)}>
        {t('resignationInformation.scheduledSource', { date: formatDmy(source.effectiveDate) })}
      </Link>
    );
  }
  return <p className="text-xs text-muted-foreground">{t(source?.kind === 'legacy' ? 'resignationInformation.legacySource' : 'resignationInformation.emptySource')}</p>;
}
