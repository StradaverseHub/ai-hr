/** AI v2 Phase 1, slice 1 (harness spec v17): whether a turn asks about what the person can do, so the harness offers
 * product_capabilities only then.
 *
 * Scored evaluations of spec v13 to v15 (runs 41577669766, 41581568138, 41583443799) found the model calling the
 * capability catalogue before answering facts and status ("is this month's payroll done?", "is Nur's leave request ok to
 * approve?"), which cost a step and lost the answer. Instruction text did not stop it, so the offer decides instead:
 * the catalogue is offered when the words ask what the person can do or whether they can do something ("can you",
 * "can I", "what can you do", "how do I"), or ask to import, upload or set something up, or to add or create something
 * new. A pure fact or status question is not offered it.
 *
 * A false positive only offers one more context tool; a false negative only means the model answers without the
 * catalogue, as it did under spec v12. Neither reads or grants anything: every tool and review page still decides as the
 * caller, and the request gate (./request-gate.ts) still removes it from a turn about another person.
 *
 * Deterministic and pure. English, Malay, Chinese and Vietnamese patterns; Tamil and Thai patterns are PENDING
 * NATIVE-SPEAKER REVIEW (as the gate's are): a floor, not a reviewed list. A pattern change raises
 * CAPABILITY_INTENT_REVISION and the harness spec version (the spec's offer.capabilityIntentRevision). */

/** Raised with every pattern change; the harness spec records it. */
export const CAPABILITY_INTENT_REVISION=1;

/** A word boundary that also holds next to letters outside ASCII (Vietnamese, Malay loan words). */
const W='(?<![\\p{L}\\p{N}])',E='(?![\\p{L}\\p{N}])';
const rx=(source:string)=>new RegExp(source,'iu');

export const CAPABILITY_PATTERNS:Readonly<Record<'en'|'ms'|'zh'|'vi'|'ta'|'th',readonly RegExp[]>>=Object.freeze({
 en:Object.freeze([
  // Whether someone can: can you, could I, are you able to, is it possible to.
  rx(`${W}(can|could)\\s+(you|i|we)${E}`),rx(`${W}(am\\s+i|are\\s+you)\\s+able\\s+to${E}`),rx(`${W}is\\s+it\\s+possible${E}`),
  // What it can do: what can you do, what can you help with, what do you do.
  rx(`${W}what\\s+(can|could|do)\\s+you\\s+(do|help|offer)${E}`),rx(`${W}what\\s+can\\s+i\\s+do${E}`),
  // How to do something.
  rx(`${W}how\\s+(do|can|should|would)\\s+(i|we)${E}`),rx(`${W}how\\s+to${E}`),
  // Import, upload or set up. Set up counts only as a request (at the start, or after to, me, I, we, please, help, need,
  // want or let's): "what's not set up yet?" and "is the payroll cycle set up?" are status questions.
  rx(`${W}(import|imports|importing|upload|uploading|bulk)${E}`),
  rx(`(^\\s*|${W}(to|me|i|we|please|help|need|want|let'?s)\\s+)(set\\s*up|setup|configure)${E}`),
  // Add or create something new.
  rx(`${W}(add|create)\\s+(a\\s+|an\\s+)?new${E}`),
 ]),
 ms:Object.freeze([
  rx(`${W}(boleh|bolehkah|dapatkah)\\s+(anda|awak|kamu|saya|tolong|ke)${E}`),
  rx(`${W}(bagaimana|macam\\s*mana|cara)\\s+(saya|nak|untuk|hendak|kita|mahu)${E}`),
  rx(`${W}apa\\s+(yang\\s+)?(anda|awak|kamu)\\s+boleh${E}`),
  rx(`${W}(import|muat\\s*naik|sediakan|tetapkan|konfigurasi)${E}`),
  rx(`${W}(tambah|cipta|wujudkan)${E}.*${W}baharu${E}`),
 ]),
 zh:Object.freeze([
  /你(能|可以|会)|我(能|可以)|能不能|能否|可不可以/u,
  /怎么|如何|怎样/u,
  /导入|上传|批量|设置|配置|新建|创建|添加新/u,
 ]),
 vi:Object.freeze([
  rx(`${W}(bạn|anh|chị|em|tôi|mình)\\s+có\\s+thể${E}`),rx(`${W}có\\s+thể${E}.*${W}không${E}`),
  rx(`${W}làm\\s+(sao|thế\\s+nào|cách\\s+nào)${E}`),rx(`${W}như\\s+thế\\s+nào${E}`),rx(`${W}cách${E}`),
  rx(`${W}(làm|giúp)\\s+được\\s+gì${E}`),
  // "nhập" alone is also "thu nhập" (income), a fact.
  rx(`(?<!thu\\s)${W}nhập${E}`),rx(`${W}(tải\\s+lên|thiết\\s+lập|cài\\s+đặt|cấu\\s+hình|tạo\\s+mới|thêm\\s+mới)${E}`),
 ]),
 // PENDING NATIVE-SPEAKER REVIEW.
 ta:Object.freeze([
  /முடியுமா|இயலுமா/u,/எப்படி|எவ்வாறு/u,/என்ன\s*செய்ய\s*முடியும்/u,
  /இறக்குமதி|பதிவேற்ற|அமைக்க|உருவாக்க|புதிதாக\s*சேர்/u,
 ]),
 // PENDING NATIVE-SPEAKER REVIEW.
 th:Object.freeze([
  /ได้ไหม|ได้มั้ย|ได้หรือไม่|ได้หรือเปล่า/u,/ทำอย่างไร|อย่างไร|ยังไง/u,/ช่วยอะไรได้บ้าง|ทำอะไรได้บ้าง/u,
  /นำเข้า|อัปโหลด|ตั้งค่า|สร้าง.{0,20}ใหม่|เพิ่ม.{0,20}ใหม่/u,
 ]),
});
/** Matched in NFKC form, the form the words are normalised to: Thai ำ (ทำ) decomposes under NFKC, so each pattern's own
 * source is normalised the same way (as the request gate's source is kept). */
const ALL:readonly RegExp[]=Object.values(CAPABILITY_PATTERNS).flat().map(pattern=>new RegExp(pattern.source.normalize('NFKC'),pattern.flags));

/** True when the person's words ask what they can do or whether they can do something, how to do something, or to import,
 * upload, set up, add or create something. Pure. */
export function asksCapability(question:string):boolean{
 const text=question.normalize('NFKC');
 return ALL.some(pattern=>pattern.test(text));
}
