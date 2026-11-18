import {expect,it} from 'vitest';
import {assessUnicodeCost,type UnicodeCostEvidence} from './performance/bulk-unicode-cost-contract';
const control:UnicodeCostEvidence={visible:1000,returned:25,identityFetched:25,sqlPaged:true,exact:true,nativeRole:'ai_hr_app',bypassRls:false,readOnly:'on',isolation:'repeatable read',jit:'off',exclusive:false,planRows:25,tempWrittenBlocks:0,bodyMaxMs:10,bodyBudgetMs:500};
it('refuses a fast complete-identity scan as SQL-bounded qualification',()=>{
 expect(assessUnicodeCost({...control,sqlPaged:false,identityFetched:1000,bodyMaxMs:1})).toMatchObject({qualified:false,gaps:['sql-count-page','ordinary-search-identity-transfer']});
});
it('keeps native authority, exactness, spills and declared diagnostic cost independent',()=>{
 expect(assessUnicodeCost(control).qualified).toBe(true); // synthetic assessor control, never a native receipt
 for(const changed of [{exact:false},{exclusive:true},{readOnly:'off'},{bypassRls:true},{nativeRole:'postgres'},{returned:26},{tempWrittenBlocks:1},{bodyMaxMs:501}])expect(assessUnicodeCost({...control,...changed}).qualified).toBe(false);
});
it('refuses missing or malformed work instead of interpreting it as zero cost',()=>{
 for(const changed of [{planRows:NaN},{identityFetched:-1},{bodyMaxMs:Infinity},{bodyBudgetMs:0},{sqlPaged:undefined},{exact:undefined}])expect(()=>assessUnicodeCost({...control,...changed} as UnicodeCostEvidence)).toThrow('Incomplete');
});
