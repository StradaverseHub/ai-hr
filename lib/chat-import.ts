/** AI v2 Phase 1, slice 3 (issue 16b) — imports inside the chat: the shared, client-safe vocabulary.
 *
 * A person who may import attaches a file in Ask. The browser reads it with the import pages' own reader
 * (lib/import-file.ts readImportFile: a workbook becomes the same CSV text the page would send), and the text travels
 * with the chat turn to the server, never to the model. The native import owner of the chosen kind previews it as the
 * caller; the model sees only the kind, row counts and issue categories (core/semantic-model/entities-imports.ts). The
 * prepared card confirms through the owner's own commit (core/chat-import/confirm.ts).
 *
 * Pure: no database, server or provider import. */

/** The proposal action and entity an import prepared in chat carries (core/proposals/chat-import.ts). */
export const CHAT_IMPORT_ACTION='imports.chat' as const;
export const CHAT_IMPORT_ENTITY='chat_import' as const;

/** The imports prepared in chat, in the fixed order they are offered and numbered. Each is a capability catalogue
 * import (core/product-context/capability-catalogue.ts IMPORT_OWNERS) whose owner previews a file without writing. */
export const CHAT_IMPORT_KINDS=['employee_records','leave_balances','payroll_history','attendance_clockings'] as const;
export type ChatImportKind=typeof CHAT_IMPORT_KINDS[number];
export const isChatImportKind=(value:unknown):value is ChatImportKind=>typeof value==='string'&&(CHAT_IMPORT_KINDS as readonly string[]).includes(value);

/** Why a row needs attention, as a closed vocabulary: the card says it in the person's language and the model sees only
 * these words, never the owner's own sentence (which can echo a cell). */
export const CHAT_IMPORT_ISSUES=['missing_column','missing_value','unknown_employee','unknown_type','invalid_date','invalid_time','invalid_number',
 'duplicate_in_file','already_imported','not_permitted','not_employed','period_closed','needs_page','other',
 // The card names one company, and the preview and Confirm import its rows only: a row of another company (even one
 // the person also administers) is reported as such and never imported here.
 'other_company'] as const;
export type ChatImportIssue=typeof CHAT_IMPORT_ISSUES[number];

/** The file types the four owners accept: workbooks and CSV for the spreadsheet imports, plain text for a time-clock file. */
export const CHAT_IMPORT_ACCEPT='.xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain';
export type ChatImportFormat='xlsx'|'xls'|'csv'|'txt';
/** The picked file itself (lib/import-file.ts MAX_IMPORT_FILE_BYTES), checked before anything is read. */
export const CHAT_IMPORT_MAX_FILE_BYTES=5_000_000;
/** The CSV text that travels (lib/import-file.ts MAX_IMPORT_CSV_BYTES, the import actions' own ceiling). */
export const CHAT_IMPORT_MAX_TEXT_BYTES=900_000;
/** A prepared import may be confirmed for this long; after it the person attaches the file again. */
export const CHAT_IMPORT_TTL_MS=30*60_000;
/** At most this many issues are listed on the card; the import page lists every one. */
export const CHAT_IMPORT_CARD_ISSUES=5;

export function chatImportFormat(name:string):ChatImportFormat|null{
 const lower=name.toLowerCase().trim();
 return lower.endsWith('.xlsx')?'xlsx':lower.endsWith('.xls')?'xls':lower.endsWith('.csv')?'csv':lower.endsWith('.txt')?'txt':null;
}

/** The attached file as it travels with a turn and with Confirm: its name, format and text. Never the bytes. */
export type ChatImportFile=Readonly<{name:string;format:ChatImportFormat;text:string}>;
const byteLength=(text:string)=>new TextEncoder().encode(text).byteLength;
/** Checks a posted file; anything malformed, oversized or of another type is null (the turn goes on without it). */
export function chatImportFileInput(raw:unknown):ChatImportFile|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const {name,format,text,...rest}=raw as Record<string,unknown>;
 if(Object.keys(rest).length||typeof name!=='string'||typeof format!=='string'||typeof text!=='string')return null;
 const base=(name.split(/[\\/]/).pop()??'').trim();
 if(!base||base.length>255||/[\u0000-\u001f]/.test(base))return null;
 if(chatImportFormat(base)!==format||!text.trim()||byteLength(text)>CHAT_IMPORT_MAX_TEXT_BYTES)return null;
 return Object.freeze({name:base,format:format as ChatImportFormat,text});
}

/** Where "Fix the rows" opens each kind, with this upload handed over (components/assistant/import-handoff.tsx). */
export const CHAT_IMPORT_PAGES:Readonly<Record<ChatImportKind,string>>=Object.freeze({
 employee_records:'/admin/personnel/import',leave_balances:'/admin/leave-config/import',payroll_history:'/payroll/history-import',attendance_clockings:'/attendance/import',
});
/** The handoff target each kind's page receives (the existing intake targets, plus the two pages this slice adds). */
export type ChatImportHandoffTarget='employee'|'leave_balances'|'payroll_history'|'attendance_clockings';
export const CHAT_IMPORT_HANDOFF:Readonly<Record<ChatImportKind,ChatImportHandoffTarget>>=Object.freeze({
 employee_records:'employee',leave_balances:'leave_balances',payroll_history:'payroll_history',attendance_clockings:'attendance_clockings',
});
