import { expect,it } from 'vitest';
import golden from './fixtures/onehr/final-band-golden.json';
import { suggestFinalBand,type GroupMode } from '../packs/performance/onehr/final-band-model';
import type { PMBand } from '../packs/performance/onehr/model';
it('matches all 540 isolated source combinations, including absent calls, weighting and exact ties',()=>{
 for(const sample of golden.cases)expect(suggestFinalBand(sample.bg as PMBand|null,sample.group as PMBand|null,sample.mode as GroupMode,sample.bgWeight)).toEqual(sample.expected);
});
