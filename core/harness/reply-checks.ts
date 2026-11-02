/** ADR-0170 §4 step 4 — deterministic reply checks, run on the model's reply before figures are restored.
 *
 *  - non_blank: no empty reply ever reaches the person;
 *  - destination_links: every product path or web address in the reply is a destination this caller has
 *    (the destination registry, plus the review route of a suggestion made in this turn);
 *  - workplace_channel (review B3): the reply never sends the person to Feedback, the product feedback board read by
 *    the software team, unless the person's own words are about the product itself (a problem, an idea, feedback);
 *  - overclaim: no claim that a change was already made (moved here from test/assistant-behaviour-score.ts,
 *    which now imports it, so the probe scores with the product's own rule);
 *  - identifiers: no IC, passport, bank account, tax, EPF or SOCSO number, phone number, email address or
 *    internal record id. The same screen (screenIdentifiers) runs on everything sent to the model, before it is sent.
 * A finding never carries reply text: identifier findings name only the kinds, link findings only how many links
 * were refused, and an overclaim none. Pure; English wording only for overclaim (ADR-0169 §6). */
import type {ReplyCheckName} from './spec';

/** ADR-0169 §6: a reply may never say a change is already made. Nothing changes in chat: every change
 * completes and is confirmed by the person on its review page, so a first-person "I've submitted it", a
 * "has been approved for you" or a bare "Done." is an overclaim. */
const OVERCLAIM:readonly RegExp[]=[
 /\bI(?:'ve|’ve| have)?\s+(?:already\s+|just\s+|now\s+)?(?:prepared|submitted|filed|applied for|approved|rejected|declined|updated|changed|saved|created|cancell?ed|processed|recorded|scheduled|booked|completed|archived|closed)\s+(?:it|this|that|the|your|a|an)\b/i,
 /\b(?:has|have)\s+been\s+(?:prepared|submitted|filed|applied|approved|rejected|updated|changed|saved|created|cancell?ed|processed|recorded|archived|closed)\b[^.!?\n]{0,40}\bfor you\b/i,
 /^\s*(?:done|all set)\s*[.!]/i,
];
// A negated statement ("nothing has been submitted for you", run 41284048653) is the correct wording, not a claim.
const NEGATED=/\b(?:nothing|not|never|no one|none|yet to)\b|n't\b|n’t\b/i;
/** The overclaiming phrase, or null. */
export function overclaim(reply:string):string|null{
 for(const sentence of reply.split(/(?<=[.!?])\s+|\n+/)){
  if(NEGATED.test(sentence))continue;
  for(const pattern of OVERCLAIM){const match=sentence.match(pattern);if(match)return match[0].trim();}
 }
 return null;
}

export type IdentifierKind='record_id'|'email'|'ic'|'tax_number'|'epf'|'socso'|'passport'|'phone'|'bank_account';
/** Applied in this order, each to what the previous ones left, so a phone number is never also a bank account and a
 * tax file is never also a passport. Internal UUIDs; email addresses; Malaysian NRIC (yymmdd-pb-####, with dashes,
 * spaces or neither, date-checked); LHDN income tax references (SG/OG/IG and the other file prefixes, or a "tax
 * number" label followed by digits); EPF (KWSP) and SOCSO (PERKESO) numbers after their label; passports (one or
 * two letters, either case, and seven to nine digits); Malaysian mobile and landline numbers (0 or +60, with or
 * without separators); and a run of ten to seventeen digits or 4-4-4+ groups (bank account). Figures with
 * separators or decimals ("1,234.50", "17.25") do not match; a full stop after a number is punctuation.
 * Review M6 adds the shipped locales' formats: Thai national ID (1-4-5-2-1), Singapore NRIC/FIN (S1234567D),
 * Thai and Vietnamese mobiles, and Malaysian bank accounts written in 3-6-3 groups. */
const IDENTIFIERS:readonly (readonly [IdentifierKind,RegExp])[]=[
 ['record_id',/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
 ['email',/\b[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}\b/gi],
 ['ic',/(?<!\d|\d[.,])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[- ]?\d{2}[- ]?\d{4}(?![.,]?\d)/g],
 // Thai national ID in its printed groups (1-2345-67890-12-3); undivided, its 13 digits are a bank-account run below.
 ['ic',/(?<!\d|\d[.,])\d[- ]\d{4}[- ]\d{5}[- ]\d{2}[- ]\d(?![.,]?\d)/g],
 // Singapore NRIC or FIN: a prefix letter, seven digits and a check letter.
 ['ic',/\b[STFGM]\d{7}[A-Z]\b/gi],
 ['tax_number',/\b(?:SG|OG|IG|C|D|E|F|J|TP|TA|TC|TN|TR|PT|LE)\s?\d{8,11}\b|\b(?:tax|TIN|cukai)\s*(?:no\.?|number|ref(?:erence)?|nombor)?\s*[:#]?\s*[A-Z]{0,2}\s?\d{6,}/gi],
 ['epf',/\b(?:EPF|KWSP)\s*(?:member(?:ship)?\s*|ahli\s*)?(?:no\.?|number|nombor)?\s*[:#]?\s*\d{6,12}(?![.,]?\d)/gi],
 ['socso',/\b(?:SOCSO|PERKESO)\s*(?:no\.?|number|nombor)?\s*[:#]?\s*[A-Z]?\d{6,12}(?![.,]?\d)/gi],
 ['passport',/\b[A-Z]{1,2}\d{7,9}\b/gi],
 ['phone',/(?<![\w+])(?:\+?60[- ]?|0)(?:1\d|[3-9])[- ]?\d{3,4}[- ]?\d{4}(?![.,]?\d)/g],
 // Thai mobiles (08x-xxx-xxxx, +66) and Vietnamese mobiles (09xx xxx xxx, +84).
 ['phone',/(?<![\w+])(?:\+?66[- ]?|0)[689]\d[- ]?\d{3}[- ]?\d{4}(?![.,]?\d)/g],
 ['phone',/(?<![\w+])(?:\+?84[- ]?|0)[35789]\d{2}[- ]?\d{3}[- ]?\d{3}(?![.,]?\d)/g],
 ['bank_account',/(?<!\d|\d[.,])\d{10,17}(?![.,]?\d)|(?<!\d|\d[.,])\d{4}[- ]\d{4}[- ]\d{4,9}(?![.,]?\d)|(?<!\d|\d[.,])\d{3}[- ]\d{6}[- ]\d{3}(?![.,]?\d)/g],
];
export type IdentifierScreen=Readonly<{text:string;count:number;kinds:readonly IdentifierKind[]}>;
/** Replaces every identifier with `[<kind> removed]`. Returns the screened text, how many were removed and their
 * kinds, never a value. Pure. */
export function screenIdentifiers(text:string):IdentifierScreen{
 let out=text,count=0;const kinds:IdentifierKind[]=[];
 for(const [kind,pattern] of IDENTIFIERS){
  out=out.replace(pattern,()=>{count++;if(!kinds.includes(kind))kinds.push(kind);return '['+kind+' removed]';});
 }
 return Object.freeze({text:out,count,kinds:Object.freeze(kinds)});
}
export function identifiersIn(reply:string):readonly IdentifierKind[]{return screenIdentifiers(reply).kinds;}

/** Product paths (a slash and a lowercase word, after a space, bracket or quote) and web addresses. */
export function linksIn(reply:string):readonly string[]{
 const paths=[...reply.matchAll(/(?:^|[\s(`"'[<])(\/[a-z][a-z0-9-]*(?:\/[a-z0-9-[\]]+)*)(?:[?#][^\s)`"'\]>]*)?/g)].map(match=>match[1]);
 const web=[...reply.matchAll(/\b(?:https?:\/\/|www\.)[^\s)`"'\]>]+/gi)].map(match=>match[0]);
 return [...paths,...web];
}
/** A path is allowed when it equals an allowed destination's path (query and fragment ignored). Web addresses never are. */
export function inventedLinks(reply:string,allowed:ReadonlySet<string>):readonly string[]{
 return linksIn(reply).filter(link=>!(link.startsWith('/')&&allowed.has(link.replace(/\/$/,'')||'/')));
}

/** Review B3 (run 41343676782, emp-harassment-split): Feedback is the product feedback board (app/feedback: issue,
 * enhancement, new function), read by the software team and the improvement loop, not HR. A link to it, or the page
 * named as a place to go, is refused unless the person is talking about the product. English and Malay page names;
 * every language through the link. */
const FEEDBACK_LINK=/(?:^|[\s(`"'[<])\/feedback(?![a-z0-9/-])/i;
const FEEDBACK_NAME=/\*\*(?:Feedback|Maklum Balas)\*\*|\b(?:use|open|go to|submit|post|send|report|raise|log|via|through|under|on|in)\s+(?:it\s+(?:in|on|via)\s+)?(?:the\s+)?(?:Feedback|Maklum Balas)\b|\b(?:Feedback|Maklum Balas)\s+(?:page|board|form|section|menu|tab|link|in the app|feature|option)\b/;
const ABOUT_PRODUCT=/\b(bugs?|glitch\w*|crash\w*|error\s+messages?|not\s+working|doesn'?t\s+work|isn'?t\s+working|broken|features?|enhancements?|feedback|suggest(ion|ions)?|ideas?|improve\s+the\s+(app|system|product|software)|(the|this)\s+(app|application|system|software|website|site|page|screen|button|menu|tool)|new\s+function\w*|maklum\s+balas|cadangan|ralat|pepijat)\b|(反馈|建议|错误|故障|功能|系统|bug)|(phản hồi|góp ý|lỗi|tính năng)|(ข้อเสนอแนะ|บั๊ก|ข้อผิดพลาด|ระบบ)|(கருத்து|பிழை|அம்சம்)/i;
/** True when the reply points to the product feedback board. */
export const pointsToFeedback=(reply:string)=>FEEDBACK_LINK.test(reply)||FEEDBACK_NAME.test(reply);
/** True when the person's words are about the product itself, the one thing Feedback is for. */
export const asksAboutProduct=(question:string)=>ABOUT_PRODUCT.test(question.normalize('NFKC'));

export type ReplyCheckResult=Readonly<{check:ReplyCheckName;ok:boolean;finding?:string}>;
export type ReplyCheckContext=Readonly<{question?:string}>;
/** Runs every check in the spec's order; all results are returned for the trace. */
export function checkReply(reply:string,allowedPaths:ReadonlySet<string>,order:readonly ReplyCheckName[],context:ReplyCheckContext={}):readonly ReplyCheckResult[]{
 return order.map((check):ReplyCheckResult=>{
  if(check==='workplace_channel')return pointsToFeedback(reply)&&!asksAboutProduct(context.question??'')?{check,ok:false,finding:'feedback channel'}:{check,ok:true};
  if(check==='non_blank')return reply.trim()?{check,ok:true}:{check,ok:false,finding:'blank reply'};
  if(check==='destination_links'){const links=inventedLinks(reply,allowedPaths);return links.length?{check,ok:false,finding:links.length+(links.length===1?' link':' links')}:{check,ok:true};}
  if(check==='overclaim')return overclaim(reply)?{check,ok:false}:{check,ok:true};
  const kinds=identifiersIn(reply);return kinds.length?{check,ok:false,finding:kinds.join(', ')}:{check,ok:true};
 });
}
