import type { Statement } from './model';

export type AnonymousFeedbackReport={
 statements:{id:string;principle:string;text:string;future:boolean;agreementPct:number|null}[];
 remarks:string[];
};

/** The report contains agreement and comments only: never a rater ID, relationship or raw score. */
export function anonymousFeedbackReport(statements:Statement[],submissions:{answers:Record<string,'yes'|'no'>;remark:string}[]):AnonymousFeedbackReport {
 return {
  statements:statements.map(s=>{
   const answers=submissions.map(r=>r.answers[s.id]).filter(a=>a==='yes'||a==='no');
   return {id:s.id,principle:s.principle,text:s.text,future:s.future,agreementPct:answers.length?Math.round(100*answers.filter(a=>a==='yes').length/answers.length):null};
  }),
  // Deliberate lexical ordering: source submission order must not reveal who wrote a comment.
  remarks:submissions.map(r=>r.remark.trim()).filter(Boolean).sort(),
 };
}
