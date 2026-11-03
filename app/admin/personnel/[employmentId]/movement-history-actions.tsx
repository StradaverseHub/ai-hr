import {movementPageHref,type MovementPageContext} from '@/lib/personnel-movement-navigation';
import Link from 'next/link';
import {ConfirmSubmit} from '../../../../components/ui/confirm-submit';
import type {MovementHistoryRow} from '../../../../core/movement';

export type MovementActionLabels = {
  view: string; edit: string; delete: string; deleteTitle: string; deleteDescription: string;
  deletePendingDescription: string; keepEvent: string; reason: string;
  hireEdit: string; hireDelete: string; hireRequirements: string;
  unavailable: string; unsupported: string; terminal: string; viewOnly: string;
  closedWarning: string; closedAcknowledge: string; processedWarning: string;
};

/** Used by the actual history table. Every write remains a server action and the service repeats scope checks. */
export function MovementHistoryActions({employmentId, row, eventLabel, canCorrect, labels, reverseAction, context}: {
  employmentId: string;
  context?: MovementPageContext;
  row: Pick<MovementHistoryRow,'id'|'kind'|'status'|'canEdit'|'canReverse'|'payrollLocked'|'payrollWarning'>;
  eventLabel: string;
  canCorrect: boolean;
  labels: MovementActionLabels;
  reverseAction: (data: FormData) => Promise<void>;
}) {
  const linkClass = 'text-primary hover:underline';
  const terminal = row.status === 'reversed' || row.status === 'superseded';
  return <div className="flex flex-wrap items-center gap-3">
    <Link href={movementPageHref(employmentId,'view',row.id,context)} className={linkClass}>{labels.view}</Link>
    {canCorrect && !terminal && row.canEdit && <Link href={movementPageHref(employmentId,'edit',row.id,context)} className={linkClass}>{labels.edit}</Link>}
    {canCorrect && row.kind === 'hired' && <>
      <Link href={movementPageHref(employmentId,'correct-hire',undefined,context)} className={linkClass}>{labels.hireEdit}</Link>
      <details className="max-w-sm text-sm"><summary className="cursor-pointer text-primary">{labels.hireDelete}</summary><p className="mt-2 text-muted-foreground">{labels.hireRequirements}</p></details>
    </>}
    {canCorrect && !terminal && row.canReverse && <form action={reverseAction} className="inline-flex">
      <input type="hidden" name="employmentId" value={employmentId}/>
      <input type="hidden" name="movementId" value={row.id}/>
      <ConfirmSubmit title={labels.deleteTitle} subtitle={eventLabel}
        description={row.status === 'pending' ? labels.deletePendingDescription : `${labels.deleteDescription}${row.payrollWarning ? ` ${labels.processedWarning}` : ''}`}
        confirmLabel={labels.delete} cancelLabel={labels.keepEvent}
        reasonField={{name:'reason',label:labels.reason,required:true}}
        acknowledgement={row.payrollLocked ? {name:'acknowledgeClosedPayroll',warning:labels.closedWarning,label:labels.closedAcknowledge} : undefined}
        variant="ghost" confirmVariant="destructive" size="sm" className="h-auto p-0 text-sm font-normal text-destructive hover:bg-transparent hover:underline">
        {labels.delete}
      </ConfirmSubmit>
    </form>}
    {(!canCorrect || terminal || row.kind !== 'hired' && (!row.canEdit || !row.canReverse)) && <details className="max-w-sm text-sm">
      <summary className="cursor-pointer text-muted-foreground">{labels.unavailable}</summary>
      <p className="mt-2 text-muted-foreground">{!canCorrect ? labels.viewOnly : terminal ? labels.terminal : labels.unsupported}</p>
    </details>}
  </div>;
}
