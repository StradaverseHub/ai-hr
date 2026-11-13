/**
 * Board d3ba1e9f — the Import History kinds that offer the standard Error Log download. Client-safe (pages and their
 * views read it without loading the server registry). core/import-error-log-registry.ts maps EXACTLY these kinds to
 * their sources (typed Record<ImportErrorLogKind, ImportErrorLogSource>), so adding a kind here without its source,
 * or a source without its kind, does not compile.
 */
import type {ImportHistoryKind} from './import-history';

export const IMPORT_ERROR_LOG_KINDS=[
 'employee_full','profile','family','qualification','emergency',
 'bank_statutory','cost_allocations','information_correction',
] as const satisfies readonly ImportHistoryKind[];
export type ImportErrorLogKind=typeof IMPORT_ERROR_LOG_KINDS[number];
export const isImportErrorLogKind=(kind:unknown):kind is ImportErrorLogKind=>typeof kind==='string'&&(IMPORT_ERROR_LOG_KINDS as readonly string[]).includes(kind);
/** True when the entry offers the Error Log: a registered kind, or a section run recorded before its type was. */
export const hasImportErrorLog=(kind:ImportHistoryKind|null|undefined,source:'attempt'|'run'='attempt'):boolean=>kind?isImportErrorLogKind(kind):source==='run';
