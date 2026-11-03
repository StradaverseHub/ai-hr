/** AI v2 Phase 2, P2-6 — redaction and fictionalisation of the few words the learning loops keep. Pure: no database, no
 * clock, no model.
 *
 * WHAT IS REPLACED, in this order (each by a numbered placeholder; the same original gets the same number):
 *  - e-mail addresses {{EMAIL_n}} and links {{LINK_n}};
 *  - money, with or without a currency ("RM45", "RM 1,200.50", "45 ringgit") {{AMOUNT_n}};
 *  - identity card numbers and other identifiers that mix letters and digits ("EMP00123", "A1234567") {{ID_n}};
 *  - calendar dates written in figures {{DATE_n}} and clock times {{TIME_n}};
 *  - phone numbers {{PHONE_n}};
 *  - every other figure, in any script's digits {{NUMBER_n}};
 *  - names: every known name passed in (the people the reader's own row-level security lets the caller see, and the
 *    caller's own name), matched as words in Latin scripts and as text in others; and, in Latin scripts, every
 *    capitalised word that does not start a sentence and is not a product or calendar word {{NAME_n}}.
 * So no digit and no "@" survives: migration 0972 refuses either in a stored example or candidate.
 *
 * LIMITS (stated, not hidden). A name written in Chinese, Thai or Tamil script is caught only when it is a known name; a
 * name at the start of a sentence only when it is known. A place or a product name written with a capital is replaced
 * too (over-redaction is the safe side). That is why nothing leaves a tenant until an administrator has read and
 * approved the redacted text, and why the export (./export.ts) replaces placeholders with fictional values only then.
 * Raised with every rule change: the stored rows record the version they were redacted under. */

export const REDACTION_VERSION=1;
export type PlaceholderKind='EMAIL'|'LINK'|'AMOUNT'|'ID'|'DATE'|'TIME'|'PHONE'|'NUMBER'|'NAME';
export const PLACEHOLDER_KINDS:readonly PlaceholderKind[]=Object.freeze(['EMAIL','LINK','AMOUNT','ID','DATE','TIME','PHONE','NUMBER','NAME']);
/** A placeholder: its kind and a letter (A, B, … Z, AA, AB …), never a digit, so a stored text holds no digit at all. */
export const PLACEHOLDER=/\{\{(EMAIL|LINK|AMOUNT|ID|DATE|TIME|PHONE|NUMBER|NAME)_([A-Z]{1,3})\}\}/g;
/** 1 -> A, 26 -> Z, 27 -> AA. */
export const placeholderLetters=(n:number):string=>{let out='';for(let i=n;i>0;i=Math.floor((i-1)/26))out=String.fromCharCode(65+(i-1)%26)+out;return out;};
const lettersNumber=(letters:string)=>[...letters].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0);
export type Redaction=Readonly<{text:string;replaced:Readonly<Record<PlaceholderKind,number>>}>;

/** Capitalised words that are not names: calendar words, product terms and language names (en, ms, vi). Lower case. */
const KEEP=new Set([
 // English calendar
 'monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april','may','june','july','august',
 'september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec',
 // Malay calendar
 'isnin','selasa','rabu','khamis','jumaat','sabtu','ahad','januari','februari','mac','mei','jun','julai','ogos','oktober','disember',
 // Product and HR terms people capitalise
 'annual','leave','medical','unpaid','hospitalisation','hospitalization','maternity','paternity','compassionate','emergency','replacement',
 'claim','claims','payroll','payslip','payslips','salary','attendance','overtime','allowance','bonus','commission','expense','travel',
 'ai','centre','center','today','insights','operations','ask','assistant','noveri','hr','admin','administrator','manager','employee',
 'company','department','team','group','approvals','approval','profile','bank','tax','form','letter','policy','handbook','holiday','public',
 'cuti','tahunan','sakit','gaji','tuntutan','kehadiran','lebih','masa','borang','cukai','syarikat','jabatan','pengurus','pekerja',
 'malaysia','malaysian','english','malay','chinese','tamil','thai','vietnamese','bahasa','melayu','i','im','ok','okay','please','thanks',
 'epf','socso','eis','pcb','mtd','ea','tp','kwsp','perkeso','lhdn','hrdf','mc','ot','toil','ic','mykad',
]);
/** Honorifics: kept as words, the name after them is replaced. */
// Not 'tan' or 'sri': Tan is also a family name.
const HONORIFICS=new Set(['mr','mrs','ms','miss','dr','encik','en','puan','pn','cik','tuan','datuk','dato','datin','haji','hajah']);

const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const LATIN=/^[\p{Script=Latin}\p{M}'’ .-]+$/u;

type Rule=Readonly<{kind:PlaceholderKind;pattern:RegExp}>;
const RULES:readonly Rule[]=Object.freeze([
 {kind:'EMAIL',pattern:/[^\s@<>()",;:!?']+@[^\s@<>()",;:!?']+\.[A-Za-z]{2,}/gu},
 {kind:'LINK',pattern:/\bhttps?:\/\/\S+|\bwww\.\S+/giu},
 {kind:'AMOUNT',pattern:/(?:\b(?:RM|MYR|USD|SGD|EUR)|[$€£¥])\s?\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?|\p{Nd}[\p{Nd},]*(?:\.\p{Nd}+)?\s?(?:ringgit|sen|MYR|RM)\b/giu},
 // A Malaysian identity card number (YYMMDD-PB-####), before the date rule could take part of it.
 {kind:'ID',pattern:/(?<!\p{Nd})\p{Nd}{6}-?\p{Nd}{2}-?\p{Nd}{4}(?!\p{Nd})/gu},
 {kind:'DATE',pattern:/(?<!\p{Nd})(?:\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}|\p{Nd}{1,2}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{2,4})(?!\p{Nd})/gu},
 {kind:'TIME',pattern:/(?<!\p{Nd})\p{Nd}{1,2}[:.]\p{Nd}{2}(?:\s?(?:am|pm|a\.m\.|p\.m\.))?(?!\p{Nd})|(?<!\p{Nd})\p{Nd}{1,2}\s?(?:am|pm)\b/giu},
 // An identifier mixing Latin letters and digits ("EMP00123", "A1234567"); Latin only, so a run of Chinese or Thai text
 // with a figure in it is never taken whole.
 {kind:'ID',pattern:/\b(?=[A-Za-z0-9-]*[0-9])(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{3,}\b/g},
 {kind:'PHONE',pattern:/\+?\p{Nd}[\p{Nd} -]{6,}\p{Nd}/gu},
 {kind:'NUMBER',pattern:/\p{Nd}+(?:[.,]\p{Nd}+)*/gu},
]);

/** While redacting, a placeholder is a private-use sentinel holding no letter and no digit (\uE000, its slot, \uE001), so
 * no later rule (a figure, a known name, a capitalised word) can match inside it. Expanded once at the end. */
type Slots={numbers:Map<string,number>;table:{kind:PlaceholderKind;n:number}[]};
const SENTINEL=/\uE000([\uE100-\uF8FF])\uE001/g;
/** Replaces every match with a placeholder, the same original keeping its letter. */
function replaceAll(text:string,kind:PlaceholderKind,pattern:RegExp,slots:Slots,counts:Record<PlaceholderKind,number>){
 return text.replace(pattern,match=>{
  const key=kind+'\u0000'+match.trim().toLowerCase();
  let slot=slots.numbers.get(key);
  if(slot===undefined){
   const n=slots.table.filter(item=>item.kind===kind).length+1;
   slot=slots.table.push({kind,n})-1;slots.numbers.set(key,slot);
  }
  counts[kind]++;
  return '\uE000'+String.fromCharCode(0xE100+slot)+'\uE001';
 });
}

/** Redacts `input`. `knownNames`: full names the caller could already see; each name and each of its words of three
 * letters or more is replaced wherever it appears. `maxLength`: the result is cut to this many characters, never inside
 * a placeholder. */
export function redact(input:string,options:Readonly<{knownNames?:readonly string[];maxLength?:number}>={}):Redaction{
 const counts:Record<PlaceholderKind,number>={EMAIL:0,LINK:0,AMOUNT:0,ID:0,DATE:0,TIME:0,PHONE:0,NUMBER:0,NAME:0};
 const numbers:Slots={numbers:new Map(),table:[]};
 // Private-use characters are the sentinels: any in the input are dropped first.
 let text=String(input??'').normalize('NFC').replace(/[\uE000-\uF8FF]/g,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
 for(const rule of RULES)text=replaceAll(text,rule.kind,rule.pattern,numbers,counts);
 // Any "@" left (an address the e-mail rule could not parse) goes too.
 text=text.replace(/@/g,' ');
 // Known names: whole names first (longest first), then their words.
 const names=[...new Set((options.knownNames??[]).map(name=>String(name).normalize('NFC').replace(/\s+/g,' ').trim()).filter(name=>name.length>=2))]
  .sort((a,b)=>b.length-a.length);
 const words=[...new Set(names.flatMap(name=>LATIN.test(name)?name.split(/[\s.-]+/).filter(word=>word.length>=3&&!KEEP.has(word.toLowerCase())&&!HONORIFICS.has(word.toLowerCase())):[]))]
  .sort((a,b)=>b.length-a.length);
 for(const name of [...names,...words]){
  const pattern=LATIN.test(name)?new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`,'giu'):new RegExp(escape(name),'gu');
  text=replaceAll(text,'NAME',pattern,numbers,counts);
 }
 // Latin capitalised words that do not start a sentence and are not kept words: names, as far as script can tell.
 text=text.replace(/(^|[.!?]\s+|\s+|[("'“‘])(\p{Lu}[\p{L}\p{M}'’-]*)/gu,(whole,before:string,word:string)=>{
  const startsSentence=before===''||/[.!?]\s+$/.test(before);
  const lower=word.toLowerCase().replace(/['’]s$/,'');
  if(startsSentence||KEEP.has(lower)||HONORIFICS.has(lower)||/^\p{Lu}{2,6}$/u.test(word))return whole;
  if(!/\p{Script=Latin}/u.test(word))return whole;
  return before+replaceAll(word,'NAME',/.+/su,numbers,counts);
 });
 // A first and a last name stay two placeholders ("{{NAME_A}} {{NAME_B}}"): each was a word.
 text=text.replace(SENTINEL,(_,slot:string)=>{const item=numbers.table[slot.charCodeAt(0)-0xE100];return `{{${item.kind}_${placeholderLetters(item.n)}}}`;})
  .replace(/\s+/g,' ').trim();
 const max=options.maxLength;
 if(max&&text.length>max){
  let cut=text.slice(0,max);
  const open=cut.lastIndexOf('{{');if(open>cut.lastIndexOf('}}'))cut=cut.slice(0,open);
  text=cut.trimEnd()+'…';
 }
 return Object.freeze({text,replaced:Object.freeze({...counts})});
}

/** True when nothing a redaction replaces is left: no digit in any script, no "@", no link. */
export function looksRedacted(text:string):boolean{
 return !/\p{Nd}/u.test(text.replace(PLACEHOLDER,''))&&!/@/.test(text)&&!/https?:\/\/|www\./i.test(text);
}

/** Fictional values for the export: the eval set's own fictional people (test/assistant-smart-eval-set.ts) and neutral
 * figures. The export says which values are fictional, so a developer sets the fixture facts to match. */
const FICTION:Readonly<Record<PlaceholderKind,readonly string[]>>=Object.freeze({
 NAME:['Siti Fictional','Wei Fictional','Nur Fictional','Ravi Fictional','Aina Fictional'],
 EMAIL:['someone@fictional.test'],LINK:['https://example.test'],AMOUNT:['RM100.00','RM250.00','RM40.00'],ID:['EMP-FICTIONAL-1','EMP-FICTIONAL-2'],
 DATE:['next Friday','the first of next month','last Monday'],TIME:['9:00 am','6:00 pm'],PHONE:['012-000 0000'],NUMBER:['2','3','5'],
});
/** Replaces each placeholder with a fictional value (the same placeholder, the same value). */
export function fictionalise(text:string):string{
 return text.replace(PLACEHOLDER,(_,kind:PlaceholderKind,letters:string)=>{const values=FICTION[kind];return values[(lettersNumber(letters)-1)%values.length];});
}
