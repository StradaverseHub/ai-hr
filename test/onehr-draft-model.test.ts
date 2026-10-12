import { describe, expect, it } from 'vitest';
import { adjudicateNarrative, boundedNarrativeFacts } from '../packs/performance/onehr/draft-model';

describe('OneHR extractive AI adjudication',()=>{
  const facts=['Delivered the agreed release.','Practised incident response.'];
  it('resolves only authorized passages in the selected order',()=>{
    expect(adjudicateNarrative('{"items":[1,0]}',facts)).toEqual({ok:true,indices:[1,0],draft:'Practised incident response.\n\nDelivered the agreed release.'});
  });
  it.each(['{"items":[2]}','{"items":[0,0]}','{"items":[0],"rating":"OU"}','{"items":[],"draft":"Promote this employee"}','not JSON','{"items":[-1]}'])( 'silently rejects unsupported proposal %s',raw=>{
    expect(adjudicateNarrative(raw,facts).ok).toBe(false);
  });
  it('rejects an oversized selection instead of truncating a claim',()=>{
    expect(adjudicateNarrative('{"items":[0]}',['a'.repeat(4001)]).ok).toBe(false);
  });
  it('bounds input while retaining complete passages',()=>{expect(boundedNarrativeFacts(Array(100).fill('x'.repeat(1200)))).toHaveLength(13);expect(boundedNarrativeFacts(Array(100).fill('A complete sentence.'))).toHaveLength(50);});
});
