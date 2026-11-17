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

/** Board 511aa74a — a Rehired row is undone by its own Roll Back (core/rehire.ts rollBackRehire), never the
 *  generic movement rollback: it removes the new employment period it started. */
export type RehireRollBack = {
  action: (data: FormData) => Promise<void>;
  labels: {button: string; title: string; description: string; reason: string; keep: string};
};

/** Used by the actual history table. Every write remains a server action and the service repeats scope checks. */
export function MovementHistoryActions({employmentId, row, eventLabel, canCorrect, canDelete = false, labels, reverseAction, context, standalone = false, rehireRollBack}: {
  employmentId: string;
  context?: MovementPageContext;
  standalone?: boolean;
  row: Pick<MovementHistoryRow,'id'|'kind'|'status'|'canEdit'|'canReverse'|'payrollLocked'|'payrollWarning'|'orderConflict'>;
  eventLabel: string;
  canCorrect: boolean;
  canDelete?: boolean;
  labels: MovementActionLabels;
  reverseAction: (data: FormData) => Promise<void>;
  rehireRollBack?: RehireRollBack;
}) {
  const linkClass = 'text-primary hover:underline';
  const terminal = row.status === 'reversed' || row.status === 'superseded'&&!row.orderConflict;
  return <div className="flex flex-wrap items-center gap-3">
    <Link href={movementPageHref(employmentId,'view',row.id,context)} className={linkClass}>{labels.view}</Link>
    {canCorrect && !terminal && row.canEdit && <Link href={movementPageHref(employmentId,'edit',row.id,context)} className={linkClass}>{labels.edit}</Link>}
    {canCorrect && row.kind === 'hired' && <>
      <Link href={movementPageHref(employmentId,'correct-hire',undefined,context)} className={linkClass}>{labels.hireEdit}</Link>
      <details className="max-w-sm text-sm"><summary className="cursor-pointer text-primary">{labels.hireDelete}</summary><p className="mt-2 text-muted-foreground">{labels.hireRequirements}</p></details>
    </>}
    {canCorrect && canDelete && !terminal && row.canReverse && <form action={reverseAction} className="inline-flex">
      <input type="hidden" name="employmentId" value={employmentId}/>
      <input type="hidden" name="movementId" value={row.id}/>
      {standalone && <>
        <input type="hidden" name="movementPage" value="history"/>
        <input type="hidden" name="showCorrected" value={context?.showCorrected??''}/>
        <input type="hidden" name="from" value={context?.from??''}/>
      </>}
      <ConfirmSubmit title={labels.deleteTitle} subtitle={eventLabel}
        description={row.status === 'pending' ? labels.deletePendingDescription : `${labels.deleteDescription}${row.payrollLocked ? ` ${labels.closedWarning}` : ''}${row.payrollWarning ? ` ${labels.processedWarning}` : ''}`}
        confirmLabel={labels.delete} cancelLabel={labels.keepEvent}
        reasonField={{name:'reason',label:labels.reason,required:true}}
        variant="ghost" confirmVariant="destructive" size="sm" className="h-auto p-0 text-sm font-normal text-destructive hover:bg-transparent hover:underline">
        {labels.delete}
      </ConfirmSubmit>
    </form>}
    {canCorrect && !terminal && row.kind === 'rehire' && rehireRollBack && <form action={rehireRollBack.action} className="inline-flex">
      <input type="hidden" name="employmentId" value={employmentId}/>
      {standalone && <input type="hidden" name="movementPage" value="history"/>}
      <ConfirmSubmit title={rehireRollBack.labels.title} subtitle={eventLabel} description={rehireRollBack.labels.description}
        confirmLabel={rehireRollBack.labels.button} cancelLabel={rehireRollBack.labels.keep}
        reasonField={{name:'reason',label:rehireRollBack.labels.reason,required:true}}
        variant="ghost" confirmVariant="destructive" size="sm" className="h-auto p-0 text-sm font-normal text-destructive hover:bg-transparent hover:underline">
        {rehireRollBack.labels.button}
      </ConfirmSubmit>
    </form>}
    {(!canCorrect || terminal || row.kind !== 'hired' && !(row.kind === 'rehire' && rehireRollBack) && (!row.canEdit || !row.canReverse)) && <details className="max-w-sm text-sm">
      <summary className="cursor-pointer text-muted-foreground">{labels.unavailable}</summary>
      <p className="mt-2 text-muted-foreground">{!canCorrect ? labels.viewOnly : terminal ? labels.terminal : labels.unsupported}</p>
    </details>}
  </div>;
}
