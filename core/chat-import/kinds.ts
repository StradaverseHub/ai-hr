/** AI v2 Phase 1, slice 3 (issue 16b) — which imports this caller may prepare in chat, and which one they mean.
 *
 * A kind is offered only while the capability catalogue (core/product-context/capability-catalogue.ts) lists its import
 * for this caller: the guard its own page uses (an HR administrator, lib/authz-model.ts isAdmin), its module on, and its
 * registry action offered where it has one. Listing grants nothing: the import owner checks the caller again, under
 * RLS, when it previews and when it commits.
 *
 * Which kind the person means is decided here, never guessed:
 *  - the number they chose from the numbered list, when their own words this turn say that number;
 *  - otherwise a kind their own words name (six interface languages; Thai, Tamil and Vietnamese pending native review);
 *  - otherwise the kind whose required columns the file's header row carries, when exactly one does.
 * The model's own pick counts only when one of those agrees with it. Otherwise the person is asked, with the kinds
 * numbered. Reads no cell beyond the header row, and nothing here reaches a model. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {parseCsvRecords} from '../../lib/csv';
import {LEAVE_IMPORT_COLUMNS} from '../../lib/leave-import-schema';
import {PAYROLL_HISTORY_COLUMNS} from '../../lib/payroll-history-import-schema';
import {IMPORT_COLUMNS} from '../../lib/import-schema';
import {CHAT_IMPORT_KINDS,CHAT_IMPORT_PAGES,isChatImportKind,type ChatImportFormat,type ChatImportKind} from '../../lib/chat-import';
import {IMPORT_OWNERS,capabilityCatalogueFor} from '../product-context/capability-catalogue';
import {wordsNameNumber} from '../proposals/suggested';

export type ChatImportKindInfo=Readonly<{kind:ChatImportKind;title:string;page:string;template:string|null;module:string|null;
 /** The import page, only when the catalogue says this caller may link it (so a reply may name it). */
 linkablePage?:string;
 /** The import owner keeps a history of the upload that can be reverted as a whole. */
 revertible:boolean;
 /** The file types this kind's own page accepts. */
 formats:readonly ChatImportFormat[];
 /** Columns the header row must carry for the file to be this kind (empty: a time-clock file has no header). */
 columns:readonly string[]}>;

/** Plain English titles for the model and the person, from the import pages' own headings. */
const TITLES:Readonly<Record<ChatImportKind,string>>=Object.freeze({
 employee_records:'Employee records',leave_balances:'Leave balances',payroll_history:'Payroll history',attendance_clockings:'Attendance clockings',
});
const FORMATS:Readonly<Record<ChatImportKind,readonly ChatImportFormat[]>>=Object.freeze({
 employee_records:['xlsx','xls','csv'],leave_balances:['xlsx','xls','csv'],payroll_history:['xlsx','xls','csv'],attendance_clockings:['csv','txt'],
});
const COLUMNS:Readonly<Record<ChatImportKind,readonly string[]>>=Object.freeze({
 employee_records:IMPORT_COLUMNS.required,leave_balances:LEAVE_IMPORT_COLUMNS.required,payroll_history:PAYROLL_HISTORY_COLUMNS.required,attendance_clockings:[],
});
/** Employee records (ADR-0155 employee_full) and payroll history keep a revertible import history; the leave balance and
 * clocking imports record their run without a revert. */
const REVERTIBLE:ReadonlySet<ChatImportKind>=new Set(['employee_records','payroll_history']);

export function chatImportKindInfo(kind:ChatImportKind):ChatImportKindInfo{
 const owner=IMPORT_OWNERS.find(row=>row.id===kind)!;
 return Object.freeze({kind,title:TITLES[kind],page:CHAT_IMPORT_PAGES[kind],template:owner.template,module:owner.module,revertible:REVERTIBLE.has(kind),
  formats:FORMATS[kind],columns:COLUMNS[kind]});
}

/** The kinds this caller may prepare in chat now, in the fixed order they are numbered. Fails closed: a catalogue that
 * cannot be read admits nothing. */
export async function chatImportKindsFor(ctx:SessionContext):Promise<readonly ChatImportKindInfo[]>{
 if(!isAdmin(ctx))return Object.freeze([]);
 let entries:ReadonlyMap<string,string|undefined>;
 try{entries=new Map((await capabilityCatalogueFor(ctx,{prepare:false})).filter(entry=>entry.kind==='import').map((entry):[string,string|undefined]=>[entry.id,entry.page]));}
 catch{return Object.freeze([]);}
 return Object.freeze(CHAT_IMPORT_KINDS.filter(kind=>entries.has('import:'+kind)).map(kind=>{const page=entries.get('import:'+kind),info=chatImportKindInfo(kind);
  return page?Object.freeze({...info,linkablePage:page}):info;}));
}

/** The person's own words name an import kind. Specific kinds first: "leave balances for each employee" is leave. */
const WORDS:readonly (readonly [ChatImportKind,RegExp])[]=[
 ['leave_balances',/\bleave\s*(?:balances?|bal|entitlements?|opening|carry[- ]?forwards?|credits?)\b|\bbaki\s+cuti\b|假期余额|年假余额|余假|số\s*dư\s*(?:ngày\s*)?phép|விடுப்பு\s*இருப்பு|วันลาคงเหลือ|ยอดวันลา/iu],
 ['payroll_history',/\b(?:payroll|pay|salary|payslips?)\s*(?:history|historical|records?)\b|\bpast\s+payslips?\b|\bsejarah\s+(?:gaji|penggajian)\b|薪资历史|工资历史|历史工资|lịch\s*sử\s*(?:bảng\s*)?lương|சம்பள\s*வரலாறு|ประวัติเงินเดือน/iu],
 ['attendance_clockings',/\bclock(?:ings?|[- ]?ins?|[- ]?outs?)?\b|\btime[- ]?clock\b|\bpunch(?:es|ing)?\b|\battendance\b|\bkehadiran\b|\bperakam\s+waktu\b|打卡|考勤|chấm\s*công|வருகை\s*பதிவு|ลงเวลา|การเข้างาน/iu],
 ['employee_records',/\b(?:new\s+)?(?:employees?|staff|workers?|personnel)\s*(?:records?|data|details|list|master)?\b|\b(?:rekod\s+)?(?:pekerja|kakitangan)\b|员工(?:资料|记录|信息)?|hồ\s*sơ\s*nhân\s*viên|nhân\s*viên|ஊழியர்\s*பதிவுகள்|ข้อมูลพนักงาน/iu],
];
export function kindsNamedBy(words:string|undefined):readonly ChatImportKind[]{
 if(typeof words!=='string'||!words.trim())return [];
 const text=words.normalize('NFKC');
 const named=WORDS.filter(([,pattern])=>pattern.test(text)).map(([kind])=>kind);
 // "employee" is a word every kind's request can carry; it names employee records only when nothing more specific does.
 return named.length>1?named.filter(kind=>kind!=='employee_records'):named;
}

/** The kinds whose required columns the header row carries (a time-clock file has no header, so never matches). */
export function kindsFittingHeader(text:string,kinds:readonly ChatImportKindInfo[]):readonly ChatImportKind[]{
 let headers:ReadonlySet<string>;
 try{const firstLine=text.split(/\r?\n/,1)[0]??'';headers=new Set(parseCsvRecords(firstLine+'\n').headers.map(header=>header.replace(/^﻿/,'')));}catch{return [];}
 return kinds.filter(row=>row.columns.length>0&&row.columns.every(column=>headers.has(column))).map(row=>row.kind);
}

export type KindResolution=Readonly<{kind:'chosen';info:ChatImportKindInfo}>|Readonly<{kind:'unclear'}>;
/** Which kind this turn's file is for. `choice` and `requested` are the model's; they count only as described above. */
export function resolveChatImportKind(kinds:readonly ChatImportKindInfo[],input:Readonly<{choice?:unknown;requested?:unknown;personWords?:string;headerText?:string}>):KindResolution{
 const byKind=(kind:ChatImportKind|undefined)=>kinds.find(row=>row.kind===kind);
 if(typeof input.choice==='string'&&/^\d{1,2}$/.test(input.choice)){
  const number=Number(input.choice);
  if(number>=1&&number<=kinds.length&&wordsNameNumber(input.personWords,number))return Object.freeze({kind:'chosen',info:kinds[number-1]});
 }
 const named=kindsNamedBy(input.personWords).filter(kind=>byKind(kind));
 const fitting=input.headerText!==undefined?kindsFittingHeader(input.headerText,kinds):[];
 const requested=typeof input.requested==='string'?input.requested.replace(/^import:/,''):undefined;
 if(isChatImportKind(requested)&&byKind(requested)&&(named.includes(requested)||fitting.includes(requested)))return Object.freeze({kind:'chosen',info:byKind(requested)!});
 if(named.length===1)return Object.freeze({kind:'chosen',info:byKind(named[0])!});
 if(!named.length&&fitting.length===1)return Object.freeze({kind:'chosen',info:byKind(fitting[0])!});
 return Object.freeze({kind:'unclear'});
}
