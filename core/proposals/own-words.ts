/** AI v2 W2 — what counts as the person's own words for a change prepared in chat.
 *
 * The model only relays: a value it passes counts only when the person's own words this turn contain it (an amount,
 * a description, an address line, a name), and a bank account or phone number is never taken from the model at all.
 * The model sees those numbers only as "[bank_account removed]" or "[phone removed]" (the harness identifier screen),
 * so they are read here from the person's own words, by the same shapes the screen removes. Pure; no read, no effect. */

/** Case, width and spacing folded, so "Jalan  Ampang" in the person's words matches "jalan ampang". */
export const squashWords=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();

/** The value, trimmed, when the person's own words contain it and it is 1..max characters; otherwise null. */
export function ownWords(value:unknown,personWords:string|undefined,max:number):string|null{
 if(typeof value!=='string'||typeof personWords!=='string')return null;
 const text=value.trim();
 if(!text||text.length>max)return null;
 return squashWords(personWords).includes(squashWords(text))?text:null;
}

/** A positive money amount with at most two decimals ("42.6", "RM 1,200", 42.6), as a number; otherwise null. */
export function parseStatedAmount(value:unknown):number|null{
 const text=typeof value==='number'?String(value):typeof value==='string'?value.trim().replace(/^(?:RM|MYR)\s*/i,'').replace(/,(?=\d{3}(?:\D|$))/g,''):'';
 if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(text))return null;
 const amount=Number(text);
 return Number.isFinite(amount)&&amount>0?amount:null;
}
/** Every amount the person's own words state, with thousands separators read ("RM1,200.50", "42.60", "42"). */
export function statedAmounts(personWords:string|undefined):number[]{
 if(typeof personWords!=='string')return [];
 const out:number[]=[];
 for(const match of personWords.matchAll(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d,])|(?<![\d.,])\d{1,9}(?:\.\d{1,2})?(?![\d,.]?\d)/g)){
  const amount=Number(match[0].replace(/,/g,''));if(Number.isFinite(amount))out.push(amount);
 }
 return out;
}
/** The person's own words state exactly this amount, to the cent. */
export const wordsStateAmount=(personWords:string|undefined,amount:number)=>statedAmounts(personWords).some(stated=>Math.round(stated*100)===Math.round(amount*100));

/** Malaysian, Thai and Vietnamese mobile and landline shapes, as the harness identifier screen reads them. */
const PHONE=/(?<![\w+])(?:\+?60[- ]?|0)(?:1\d|[3-9])[- ]?\d{3,4}[- ]?\d{4}(?![.,]?\d)|(?<![\w+])(?:\+?66[- ]?|0)[689]\d[- ]?\d{3}[- ]?\d{4}(?![.,]?\d)|(?<![\w+])(?:\+?84[- ]?|0)[35789]\d{2}[- ]?\d{3}[- ]?\d{3}(?![.,]?\d)/g;
/** Malaysian NRIC (yymmdd-pb-####, date-checked), which a bank-account shape must never be read as. */
const IC=/(?<!\d|\d[.,])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?\d{2}[- ]?\d{4}(?![.,]?\d)/g;
/** Ten to seventeen digits, or 4-4-4+ or 3-6-3 groups: a bank account as the screen reads it. */
const BANK=/(?<!\d|\d[.,])\d{10,17}(?![.,]?\d)|(?<!\d|\d[.,])\d{4}[- ]\d{4}[- ]\d{4,9}(?![.,]?\d)|(?<!\d|\d[.,])\d{3}[- ]\d{6}[- ]\d{3}(?![.,]?\d)/g;

/** The one phone number in the person's own words, as they typed it (trimmed), or null when none or several. */
export function onePhoneIn(personWords:string|undefined):string|null{
 if(typeof personWords!=='string')return null;
 const found=[...new Set([...personWords.matchAll(PHONE)].map(match=>match[0].trim()))];
 return found.length===1?found[0]:null;
}
/** The one bank account number in the person's own words, digits only, or null when none or several. A phone number
 * or an NRIC is never read as an account: those shapes are taken out first, in the screen's own order. */
export function oneBankAccountIn(personWords:string|undefined):string|null{
 if(typeof personWords!=='string')return null;
 const rest=personWords.replace(PHONE,' ').replace(IC,' ');
 const found=[...new Set([...rest.matchAll(BANK)].map(match=>match[0].replace(/\D/g,'')))];
 return found.length===1&&found[0].length>=10&&found[0].length<=17?found[0]:null;
}

/** One of a closed list by name or code: an exact match first, then the one name containing the words or contained in
 * them. Null when there is none or more than one. */
export function matchNamed<T extends Readonly<{name:string;code?:string}>>(rows:readonly T[],given:string):T|null{
 const asked=squashWords(given);
 if(!asked)return null;
 const exact=rows.filter(row=>squashWords(row.name)===asked||(row.code!==undefined&&squashWords(row.code)===asked));
 if(exact.length===1)return exact[0];
 if(exact.length>1)return null;
 const loose=rows.filter(row=>{const name=squashWords(row.name);return name.includes(asked)||asked.includes(name);});
 return loose.length===1?loose[0]:null;
}
