/** AI v2 Phase 1 slice 3 — the specific title of an own letter request card prepared in chat: "Employment confirmation
 * letter request", in the person's locale (aiCentre.conversation.letterRequestTitle in messages/ai-centre/<locale>.json).
 *
 * The letter type is the signed proposal's own: the published template name the person's company opened for employee
 * requests. A card without it keeps its generic title (null). Pure. */
export type LetterRequestTitleKey='letterRequestTitle';
type Translate=(key:LetterRequestTitleKey,values:Record<string,string>)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string}>;facts?:Readonly<{letterType?:string}>}>;

export function letterRequestCardTitle(body:TitledProposal,t:Translate):string|null{
 const type=body.facts?.letterType?.trim();
 return body.what.action==='letters.request.submit'&&type?t('letterRequestTitle',{letterType:type}):null;
}
