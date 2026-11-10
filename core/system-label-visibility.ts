/** Staged System Labels import rows (migration 5070) on connections that row security does not govern.
 *
 * A staged code is written by the import's chunk transactions and stays invisible until its release: a RESTRICTIVE
 * policy hides it from every role subject to row security, and the audited definers filter it. The storage-owner
 * connection (scheduled sweeps, operator scripts, the import worker) bypasses row security, so a reader there that
 * ENUMERATES a catalogue table must add this predicate. A reader that reaches a catalogue row only through a stored
 * reference (an assignment's department, a case's position) needs nothing: no stored reference names a staged code.
 * The audit of every owner-connection reader is in docs/adr/2026-11-10-system-label-import-staged-job.md and is
 * pinned by test/system-label-import-owner-readers.test.ts. */
import {getTableName,sql,type SQL} from 'drizzle-orm';
import type {businessUnit,costCenter,department,gradeGroup,gradeGroupMember,jobGrade,labelCompanyAssignment,position,profileOption} from '../db/schema';

export type SystemLabelCatalogueTable=typeof department|typeof position|typeof costCenter|typeof businessUnit|typeof labelCompanyAssignment|
 typeof profileOption|typeof jobGrade|typeof gradeGroup|typeof gradeGroupMember;
/** True for an unstaged row, the session's own import (its chunk transactions) or a released import's row. */
export function releasedLabelRows(table:SystemLabelCatalogueTable):SQL{
 return sql`app.label_import_marker_visible(${sql.identifier(getTableName(table))}.import_pending_attempt_id)`;
}
