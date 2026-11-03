/** AI v2 W2 (slice 2) — the specific title of a Leave Credit request (time off in lieu) card prepared in chat:
 * "Leave Credit request, Sat 1 Nov, 9:00 am – 5:00 pm", in the person's locale (aiCentre.conversation.toilRequestTitle
 * in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the date worked and the window the person gave, as the leave service
 * reviewed them. Nothing is computed here; a card without those facts keeps its generic title (null). The day is
 * formatted as a calendar date and the times as wall times, both in UTC, so no time zone can move them (they are
 * already Kuala Lumpur values). Pure. */
export type ToilRequestTitleKey='toilRequestTitle';
type Translate=(key:ToilRequestTitleKey,values:Record<string,string>)=>string;
type Format=(date:Date)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string}>;facts?:Readonly<{startDate?:string;plannedStart?:string;plannedEnd?:string}>}>;

const DATE=/^\d{4}-\d{2}-\d{2}$/,TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function toilRequestCardTitle(body:TitledProposal,t:Translate,formatDate:Format,formatTime:Format):string|null{
 const facts=body.facts??{},day=facts.startDate;
 if(body.what.action!=='toil.replacement.request'||!day||!DATE.test(day))return null;
 const time=(value:string|undefined)=>value&&TIME.test(value)?formatTime(new Date('1970-01-01T'+value+':00.000Z')):null;
 const start=time(facts.plannedStart),end=time(facts.plannedEnd);
 return start&&end?t('toilRequestTitle',{date:formatDate(new Date(day+'T00:00:00.000Z')),start,end}):null;
}
