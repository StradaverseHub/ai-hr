/** Home's lexical query contract. No model, fallback suggestions or stored query text. */
export const HOME_SEARCH_QUERY_MAX=120;
export const HOME_SEARCH_RESULT_LIMIT=8;
export const HOME_SEARCH_DEBOUNCE_MS=350;
export class HomeSearchQueryError extends RangeError{
  constructor(){super('Invalid Home search query.');this.name='HomeSearchQueryError';}
}
export const homeKnowledgeHref=(id:string)=>'/knowledge-base/'+encodeURIComponent(id);
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
