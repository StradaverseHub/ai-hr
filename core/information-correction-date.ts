import { sql, type SQL } from 'drizzle-orm';
import { isCalendarDate } from '../lib/calendar-date';

export const INFORMATION_CORRECTION_DATE_ALIGNED = 'employment.information.effective-date-aligned';
export const INFORMATION_CORRECTION_DATE_AGGREGATE = 'information-correction-date';

export type CorrectionDateAlignment = {
  correctionId: string;
  originalEffectiveOn: string;
  alignedEffectiveOn: string;
  movementId: string;
};

/** A date projection for Personnel and Movement display. Physical timeline and payroll owners
 * continue to consume the original evidence, including its original boundary dates. */
export function informationDateAlignmentValueSql(field: 'alignedEffectiveOn' | 'movementId'): SQL<string | null> {
  // Keep the outer relation explicit. Drizzle removes column qualifiers in a single-table SELECT list.
  return sql`(
    select amendment.payload->>${field}::text
    from domain_event amendment
    where amendment.tenant_id = domain_event.tenant_id
      and amendment.subject_employment_id = domain_event.subject_employment_id
      and amendment.aggregate_type = ${INFORMATION_CORRECTION_DATE_AGGREGATE}
      and amendment.aggregate_id = domain_event.id
      and amendment.event_type = ${INFORMATION_CORRECTION_DATE_ALIGNED}
      and amendment.payload->>'originalEffectiveOn' = domain_event.payload->>'effectiveOn'
    order by amendment.sequence desc
    limit 1
  )`;
}

export function alignedInformationDateSql() {
  return informationDateAlignmentValueSql('alignedEffectiveOn');
}

export function withAlignedInformationDate(payload: unknown, alignedDate: string | null | undefined): unknown {
  if (!alignedDate || !isCalendarDate(alignedDate) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const original = (payload as { effectiveOn?: unknown }).effectiveOn;
  return typeof original === 'string' && isCalendarDate(original) && alignedDate < original
    ? { ...payload, effectiveOn: alignedDate, originalEffectiveOn: original }
    : payload;
}
