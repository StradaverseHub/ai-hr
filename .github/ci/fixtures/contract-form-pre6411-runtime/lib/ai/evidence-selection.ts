import { z } from 'zod';

/** Bound provider input without cutting a factual passage in half. */
export function boundedNarrativeFacts(passages:readonly string[]):string[] {
 const result:string[]=[];let length=0;for(const text of passages){if(!text||length+text.length>16000)continue;if(result.length===50)break;result.push(text);length+=text.length;}return result;
}

/** The model selects and orders existing evidence. Only deterministically resolved text is displayed. */
export function adjudicateNarrative(raw:string, facts:readonly string[]):{ok:true;indices:number[];draft:string}|{ok:false;reason:string} {
  try {
    const proposal=z.object({items:z.array(z.number().int().min(0)).min(1).max(30)}).strict().parse(JSON.parse(raw));
    if(new Set(proposal.items).size!==proposal.items.length||proposal.items.some(i=>i>=facts.length))return {ok:false,reason:'Unknown or duplicate evidence reference.'};
    const draft=proposal.items.map(i=>facts[i]).join('\n\n');
    if(draft.length>4000)return {ok:false,reason:'Draft exceeds the allowed length.'};
    return {ok:true,indices:proposal.items,draft};
  } catch { return {ok:false,reason:'Invalid evidence selection.'}; }
}
