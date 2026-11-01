/** ADR-0170 §3.3 — exact-value restoration: the model saw placeholders, the person sees the exact figure, name,
 * date or label ({{F#}} figures and {{T#}} withheld text alike).
 *
 * A placeholder is restored only when every condition holds:
 *  - it was issued in this turn's ledger (a model-invented `{{F9}}` is never filled);
 *  - it was issued for this same caller (tenant, user, person, roles and grants unchanged);
 *  - the read that produced it is still one this caller is offered now.
 * Anything else is replaced by the spec's "not available" text and listed in the trace. The exact value is
 * the owner's own figure, printed as it was returned: the harness never computes with it. Pure.
 *
 * modelSide() is the other half: the same reply as the model wrote it, for the next turn's history. A figure
 * placeholder becomes its band and a text placeholder a fixed marker, so nothing restored is ever sent back. */
import {bandOf,type DisclosureLedger} from './disclosure';
import {HARNESS_SPEC} from './spec';

const pattern=(template:string)=>template.replace(/[{}]/g,'\\$&').replace('#','\\d+');
const PLACEHOLDER=new RegExp(pattern(HARNESS_SPEC.disclosure.placeholder)+'|'+pattern(HARNESS_SPEC.disclosure.textPlaceholder),'g');
export type Restoration=Readonly<{reply:string;restored:number;refused:readonly Readonly<{placeholder:string;reason:'unknown'|'other_caller'|'not_permitted'}>[]}>;
export function restoreFigures(reply:string,ledger:DisclosureLedger,callerKey:string,permittedTools:ReadonlySet<string>):Restoration{
 let restored=0;const refused:{placeholder:string;reason:'unknown'|'other_caller'|'not_permitted'}[]=[];
 const text=reply.replace(PLACEHOLDER,placeholder=>{
  const figure=ledger.figures.get(placeholder)??ledger.texts.get(placeholder);
  const reason=!figure?'unknown':figure.callerKey!==callerKey?'other_caller':!permittedTools.has(figure.tool)?'not_permitted':null;
  if(reason||!figure){refused.push({placeholder,reason:reason??'unknown'});return HARNESS_SPEC.replyChecks.unavailableFigure;}
  restored++;return String(figure.value);
 });
 return Object.freeze({reply:text,restored,refused:Object.freeze(refused)});
}
/** The reply as the model may see it again: no exact figure, no restored name, date or label. */
export function modelSide(reply:string,ledger:DisclosureLedger):string{
 return reply.replace(PLACEHOLDER,placeholder=>{
  const figure=ledger.figures.get(placeholder);
  return figure?HARNESS_SPEC.history.figure.replace('{band}',bandOf(figure.value)):HARNESS_SPEC.history.text;
 });
}
