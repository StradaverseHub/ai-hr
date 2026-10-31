import {expect,it} from 'vitest';
import {applicationPoolMax} from '../lib/db-pool-size';
it('defaults to ten and accepts only bounded integer pool sizes',()=>{
 expect(applicationPoolMax(undefined)).toBe(10);expect(applicationPoolMax('')).toBe(10);
 for(const size of ['1','10','20','40'])expect(applicationPoolMax(size)).toBe(Number(size));
 for(const size of ['0','-1','1.5','41','NaN',' 20','+20'])expect(()=>applicationPoolMax(size)).toThrow(RangeError);
});
