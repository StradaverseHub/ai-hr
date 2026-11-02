/** ADR-0169 phase B — product guidance for the Assistant context layer.
 *
 * Reuses the knowledge-base owners rather than a second index: the tenant's own published library
 * (provisioning seeds the bundled guides; tenants may edit or archive them), filtered by the caller's
 * audience clearance and locale under tenant RLS. Returns the most relevant authored section of each
 * matching document, bounded, with its in-product link. Never a generated summary. Not imported by the
 * production Assistant (outside the provider privacy closure until the ADR-0169 §5.1 review passes). */
import type {SessionContext} from '../../db/client';
import {getDocument,searchHomeKnowledgeDocuments} from '../knowledge-base';
import {homeSearchWords,HomeSearchQueryError} from '../../lib/employee-home-search';

export type ProductGuidance=Readonly<{title:string;href:string;section:string|null;excerpt:string}>;
const SECTION_MAX=2400,RESULTS=3,FALLBACK_TERMS=4;

/** Authored markdown split on level-2/3 headings; the leading text before the first heading is "intro". */
function sections(body:string):{heading:string|null;text:string}[]{
 const parts:{heading:string|null;text:string}[]=[];let heading:string|null=null,lines:string[]=[];
 for(const line of body.split('\n')){const match=/^#{2,3}\s+(.+)$/.exec(line);
  if(match){if(lines.join('').trim())parts.push({heading,text:lines.join('\n').trim()});heading=match[1].trim();lines=[];}else lines.push(line);}
 if(lines.join('').trim())parts.push({heading,text:lines.join('\n').trim()});
 return parts;
}
function bestSection(body:string,words:readonly string[]){
 const scored=sections(body).map(part=>{const heading=(part.heading??'').toLowerCase(),text=part.text.toLowerCase();
  return{part,score:words.reduce((sum,word)=>sum+(heading.includes(word)?4:0)+(text.split(word).length-1),0)};});
 const best=scored.sort((a,b)=>b.score-a.score)[0]?.part;if(!best)return null;
 const chars=Array.from(best.text);
 return{section:best.heading,excerpt:chars.length>SECTION_MAX?chars.slice(0,SECTION_MAX).join('')+'…':best.text};
}
/** Up to three authored guide sections relevant to `query`, in the caller's locale and clearance. */
export async function productGuidance(ctx:SessionContext,query:string,locale='en'):Promise<readonly ProductGuidance[]>{
 let words:string[];try{words=homeSearchWords(query);}catch(error){if(error instanceof HomeSearchQueryError)return [];throw error;}
 if(!words.length)return [];
 // The library search requires every word; fall back to the leading significant terms one at a time.
 const counts=new Map<string,{hit:Awaited<ReturnType<typeof searchHomeKnowledgeDocuments>>[number];score:number}>();
 const add=(hits:Awaited<ReturnType<typeof searchHomeKnowledgeDocuments>>,weight:number)=>hits.forEach((hit,index)=>{
  const prior=counts.get(hit.id);counts.set(hit.id,{hit,score:(prior?.score??0)+weight*(10-index)});});
 add(await searchHomeKnowledgeDocuments(ctx,words.join(' '),locale),3);
 if(counts.size<RESULTS)for(const word of words.slice(0,FALLBACK_TERMS))add(await searchHomeKnowledgeDocuments(ctx,word,locale),1);
 const ranked=[...counts.values()].filter(row=>row.hit.kind==='article').sort((a,b)=>b.score-a.score).slice(0,RESULTS);
 const results:ProductGuidance[]=[];
 for(const {hit} of ranked){
  const document=await getDocument(ctx,hit.id,locale);if(!document?.body)continue;
  const best=bestSection(document.body,words);if(!best)continue;
  results.push(Object.freeze({title:document.title,href:hit.href,section:best.section,excerpt:best.excerpt}));
 }
 return Object.freeze(results);
}
