import type { AssignmentRecordSource } from '@/core/assignment-record-source';
import { InformationCorrectionDrawer } from '../information-correction-form';

/**
 * Board eb01800b — the Employment History line for a dated record that is not a career movement (an
 * Information-Only Correction, an organisation-structure update or an untagged assignment change). Every caption
 * arrives translated from the page. View opens the record's facts in place; Correct (maintain authority, never for
 * an organisation-structure update) opens Information-Only Correction on the record's Effective Date.
 */
export type MovementRecordChangeLabels = {
  title: string;
  badge: string;
  /** "by NAME on DATE" or "recorded on DATE", already formatted; empty when unknown. */
  recorded: string;
  noFields: string;
  view: string;
  changed: string;
  before: string;
  after: string;
  effectiveDate: string;
  correct: string;
  hint: string;
};

export function MovementRecordChangeSummary({ record, fieldLabels, labels }: {
  record: AssignmentRecordSource;
  fieldLabels: Record<string, string>;
  labels: MovementRecordChangeLabels;
}) {
  const fields = record.fields.map((f) => fieldLabels[f] ?? f).join(', ');
  return (
    <>
      <span>{labels.title}</span>
      <span className="ml-2 rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-indigo-800 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300">
        {labels.badge}
      </span>
      <p className="mt-1 text-xs font-normal text-muted-foreground" data-record-fields="">
        {fields || labels.noFields}
        {labels.recorded ? ` · ${labels.recorded}` : ''}
      </p>
    </>
  );
}

export function MovementRecordChangeActions({ employmentId, record, fieldLabels, labels, effectiveDateText, canCorrect }: {
  employmentId: string;
  record: AssignmentRecordSource;
  fieldLabels: Record<string, string>;
  labels: MovementRecordChangeLabels;
  effectiveDateText: string;
  canCorrect: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <details className="max-w-sm text-sm">
        <summary className="cursor-pointer text-primary">{labels.view}</summary>
        <dl className="mt-2 space-y-1 text-xs">
          <div><dt className="inline text-muted-foreground">{labels.effectiveDate}: </dt><dd className="inline tabular-nums">{effectiveDateText}</dd></div>
          <div><dt className="inline text-muted-foreground">{labels.changed}: </dt><dd className="inline">{record.fields.map((f) => fieldLabels[f] ?? f).join(', ') || labels.noFields}</dd></div>
          {record.values.map((value) => (
            <div key={value.field} data-record-value={value.field}>
              <dt className="inline text-muted-foreground">{fieldLabels[value.field] ?? value.field}: </dt>
              <dd className="inline">{labels.before} {value.before ?? '—'} → {labels.after} {value.after ?? '—'}</dd>
            </div>
          ))}
          {labels.recorded && <div><dd className="text-muted-foreground">{labels.recorded}</dd></div>}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">{labels.hint}</p>
      </details>
      {canCorrect && record.kind !== 'mapping' && (
        <InformationCorrectionDrawer employmentId={employmentId} effectiveOn={record.effectiveDate} label={labels.correct} />
      )}
    </div>
  );
}
