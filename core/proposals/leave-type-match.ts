/** Issue 10 follow-up — which of the caller's own leave types a chat request names, in all six product languages.
 *
 * The model passes the leave type as the person said it ("病假", "cuti sakit", "MC", "ลาป่วย"). It is matched only
 * against the caller's own apply menu (core/assistant-actions/own-leave-apply-form.ts readOwnLeaveApplyMenu), so a
 * type the caller may not apply for can never be chosen; the leave service still decides at Confirm. In order:
 *  1. a type's own name in any language, or its code, exactly (ignoring case, spacing and the word "leave");
 *  2. the kind of leave the words name (annual, sick, hospitalisation, emergency, unpaid, maternity, paternity), by
 *     the common names and synonyms below, against each type's kind: its role (leave_type.role), else its seeded
 *     code, else the kind its own names name. The more specific kind wins where one phrase holds two ("陪产假"
 *     holds "产假", "cuti sakit hospital" holds "sakit"); two kinds otherwise ("unpaid medical") is unclear;
 *  3. the one type whose name contains the words.
 * One type is a match. None, or several of one kind (two medical types), is unclear: the person is asked. Pure. */

export const LEAVE_KINDS=['annual','sick','hospitalization','emergency','unpaid','maternity','paternity'] as const;
export type LeaveKind=typeof LEAVE_KINDS[number];
export type MatchableLeaveType=Readonly<{id:string;name:string;code:string;role:string|null;
 /** The type's names in every language it carries (its own name and its translations). */names:readonly string[]}>;

/** A Latin-script term, matched as whole words (Malay, Vietnamese and English diacritics included). Terms are kept in
 * NFKC form, the form the words are matched in, so Thai ำ (NFKC ํา) and Vietnamese marks compare as written. */
const word=(term:string)=>new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${term.normalize('NFKC')}(?![\\p{L}\\p{N}\\p{M}])`,'u');
/** A term in a script without spaces between words (Chinese, Thai) or with combining marks (Tamil): a substring. */
const part=(term:string)=>new RegExp(term.normalize('NFKC'),'u');
/** Common names and synonyms per kind: en, ms, zh, vi, ta, th. Lower-case, NFKC. */
const SYNONYMS:Readonly<Record<LeaveKind,readonly RegExp[]>>={
 annual:[word('annual'),word('vacation'),word('al'),word('pto'),word('paid time off'),word('tahunan'),word('cuti rehat'),
  part('年假'),part('年休'),word('phép năm'),word('nghỉ phép năm'),part('வருடாந்திர'),part('ஆண்டு விடுப்பு'),part('พักร้อน'),part('พักผ่อนประจำปี')],
 sick:[word('sick'),word('medical'),word('mc'),word('illness'),word('ill'),word('sakit'),word('perubatan'),
  part('病假'),part('病休'),part('医疗假'),part('生病'),word('ốm'),word('nghỉ ốm'),word('bệnh'),word('y tế'),
  part('மருத்துவ'),part('நோய்'),part('ป่วย')],
 hospitalization:[word('hospital'),word('hospitali[sz]ation'),word('inpatient'),word('wad'),word('masuk wad'),word('kemasukan wad'),
  part('住院'),word('nằm viện'),word('nhập viện'),word('bệnh viện'),part('மருத்துவமனை'),part('โรงพยาบาล')],
 emergency:[word('emergency'),word('urgent'),word('kecemasan'),part('紧急'),part('急事'),word('khẩn cấp'),part('அவசர'),part('ฉุกเฉิน')],
 unpaid:[word('unpaid'),word('no[ -]?pay'),word('without pay'),word('npl'),word('lwop'),word('tanpa gaji'),word('tidak bergaji'),
  part('无薪'),part('停薪'),word('không lương'),part('ஊதியமில்லா'),part('சம்பளமில்லா'),part('ไม่รับค่าจ้าง'),part('ไม่ได้รับค่าจ้าง'),part('ไม่รับเงินเดือน')],
 maternity:[word('maternity'),word('bersalin'),part('产假'),word('thai sản'),part('மகப்பேறு'),part('คลอด')],
 paternity:[word('paternity'),word('paterniti'),word('isteri bersalin'),part('陪产'),word('vợ sinh'),word('cho chồng'),
  part('தந்தை'),part('ภรรยาคลอด'),part('ภริยาคลอด')],
};
/** Where one phrase names two kinds, the more specific one: paternity holds maternity's words, hospitalisation sick's. */
const SPECIFIC:Readonly<Partial<Record<LeaveKind,LeaveKind>>>={maternity:'paternity',sick:'hospitalization'};
/** Seeded and common codes that name a kind when a type carries no role. */
const CODES:Readonly<Record<string,LeaveKind>>={ANNUAL:'annual',AL:'annual',SICK:'sick',MEDICAL:'sick',MC:'sick',SL:'sick',
 HOSPITALIZATION:'hospitalization',HOSPITALISATION:'hospitalization',EMERGENCY:'emergency',EL:'emergency',UNPAID:'unpaid',NPL:'unpaid',UL:'unpaid',
 MATERNITY:'maternity',MTL:'maternity',PATERNITY:'paternity',PTL:'paternity'};

const lower=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
/** Name or code for an exact comparison: no case, spacing, punctuation or the word "leave" in any language. */
const GENERIC=new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])(?:${['leave','cuti','nghỉ phép','விடுப்பு'].map(term=>term.normalize('NFKC')).join('|')})(?![\\p{L}\\p{N}\\p{M}])`,'gu');
const exactKey=(value:string)=>lower(value).replace(GENERIC,' ').replace(/[假]$/u,'').replace(/^ลา/u,'').replace(/[^\p{L}\p{N}\p{M}]+/gu,'');

/** The one kind these words name, or null when they name none or two unrelated kinds. */
export function leaveKindOf(words:string):LeaveKind|null{
 const text=lower(words);if(!text)return null;
 let kinds=LEAVE_KINDS.filter(kind=>SYNONYMS[kind].some(pattern=>pattern.test(text)));
 for(const [general,specific] of Object.entries(SPECIFIC) as [LeaveKind,LeaveKind][])if(kinds.includes(specific))kinds=kinds.filter(kind=>kind!==general);
 return kinds.length===1?kinds[0]:null;
}
/** A type's kind: its role, else its seeded code, else what its own names name. Unclassified types have none. */
export function leaveKindOfType(type:MatchableLeaveType):LeaveKind|null{
 if(type.role)return (LEAVE_KINDS as readonly string[]).includes(type.role)?type.role as LeaveKind:null;
 const code=CODES[type.code.trim().toUpperCase()];if(code)return code;
 const kinds=new Set([type.name,...type.names].map(leaveKindOf).filter((kind):kind is LeaveKind=>kind!==null));
 return kinds.size===1?[...kinds][0]:null;
}

export type LeaveTypeMatch<T>=Readonly<{kind:'one';type:T}>|Readonly<{kind:'unclear'}>;
const one=<T>(found:readonly T[]):LeaveTypeMatch<T>|null=>found.length===1?Object.freeze({kind:'one' as const,type:found[0]}):found.length?Object.freeze({kind:'unclear' as const}):null;
/** The caller's own leave type these words name, or unclear. Only `types` (the caller's own menu) can be returned. */
export function matchLeaveTypeWords<T extends MatchableLeaveType>(types:readonly T[],given:string):LeaveTypeMatch<T>{
 const unclear=Object.freeze({kind:'unclear' as const}),key=exactKey(given);
 if(!key)return unclear;
 const exact=one(types.filter(type=>[type.name,...type.names,type.code].some(name=>exactKey(name)===key)));
 if(exact)return exact;
 const kind=leaveKindOf(given);
 if(kind){const byKind=one(types.filter(type=>leaveKindOfType(type)===kind));if(byKind)return byKind;}
 return one(types.filter(type=>[type.name,...type.names].some(name=>exactKey(name).includes(key))))??unclear;
}
