/**
 * Board eb01800b — the refusal sentence for a dated change that a later assignment record blocks, in the viewer's
 * language (people.detail.assignmentBlocked.*), and the marker that lets the New Event screen link to that record's
 * line in Employment History. Pure: the caller passes its translators and date format.
 */
export type BlockedAssignmentRecord = {
  versionId: string;
  kind: 'correction' | 'mapping' | 'movement' | 'untagged';
  effectiveDate: string;
  fields: readonly string[];
};

type Translate = (key: string, values?: Record<string, string>) => string;

export function assignmentBlockedMessage(
  record: BlockedAssignmentRecord,
  date: string,
  t: Translate,
  fieldLabel: (field: string) => string,
  formatDate: (date: string) => string,
): string {
  const fields = record.kind !== 'movement' && record.fields.length ? ` (${record.fields.map(fieldLabel).join(', ')})` : '';
  return t(`assignmentBlocked.${record.kind}`, { fields, recordDate: formatDate(record.effectiveDate), date: formatDate(date) });
}

/** The marker is appended only on the inline New Event path, whose error area renders it as a link. */
const MARKER = /\s*\[\[movement-record:([0-9a-fA-F-]{36})\]\]\s*$/;
export function withMovementRecordMarker(message: string, versionId: string): string {
  return `${message} [[movement-record:${versionId}]]`;
}
export function splitMovementRecordMarker(message: string): { text: string; versionId: string | null } {
  const match = MARKER.exec(message);
  return match ? { text: message.slice(0, match.index), versionId: match[1] } : { text: message, versionId: null };
}
/** The id the record's row carries in the Movement table (the link's fragment). */
export const movementRecordAnchor = (versionId: string) => `movement-record-${versionId}`;
