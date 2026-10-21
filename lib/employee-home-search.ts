/** Home's lexical query contract. No model, fallback suggestions or stored query text. */
export const HOME_SEARCH_QUERY_MAX=120;
export const HOME_SEARCH_RESULT_LIMIT=8;
export const HOME_SEARCH_DEBOUNCE_MS=350;
export const HOME_SEARCH_DESCRIPTION_MAX=240;
export class HomeSearchQueryError extends RangeError{
  constructor(){super('Invalid Home search query.');this.name='HomeSearchQueryError';}
}
export const homeKnowledgeHref=(id:string)=>'/knowledge-base/'+encodeURIComponent(id);
/** A bounded literal excerpt from an already-authorized authored document, never a generated summary.
 * The preview renderer uses the incumbent Markdown parser with links/images/raw HTML disabled. */
export function homeKnowledgeExcerpt(body:string|null):string|null{
  const text=body?.trim();if(!text)return null;
  const characters=Array.from(text);
  return characters.length>HOME_SEARCH_DESCRIPTION_MAX?characters.slice(0,HOME_SEARCH_DESCRIPTION_MAX).join('')+'…':text;
}
// Fixed Unicode patterns retain letters and combining marks. User input never becomes a pattern.
const wordsPattern=new RegExp('[\\p{L}\\p{M}\\p{N}]+','gu');
const significantPattern=new RegExp('[\\p{L}\\p{N}]','u');

export function homeSearchWords(raw:unknown):string[]{
  if(typeof raw!=='string'||raw.length>HOME_SEARCH_QUERY_MAX)throw new HomeSearchQueryError();
  const query=raw.normalize('NFKC').trim().toLowerCase();
  if(query.length>HOME_SEARCH_QUERY_MAX)throw new HomeSearchQueryError();
  const words=query.match(wordsPattern)??[];
  return [...new Set(words.filter(word=>significantPattern.test(word)))];
}
