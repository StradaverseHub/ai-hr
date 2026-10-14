import sourceGolden from './fixtures/onehr/development-suggestion-golden.json';
import { expect,it } from 'vitest';
import { developmentItems,parseDevelopmentSuggestions } from '../packs/performance/onehr/development-suggestion-model';
import type { Competency } from '../packs/performance/onehr/model';
const competencies:Competency[]=[
 {id:'current',principle:'Technical',text:'Prepare an operational plan',future:false,skillTitle:'Planning',self:'yes',manager:'no',managerRemark:''},
 {id:'next',principle:'Technical',text:'Lead cross-unit planning',future:true,skillTitle:'Planning',self:'no',manager:'no',managerRemark:''},
 {id:'met',principle:'Technical',text:'Resolve an incident',future:false,skillTitle:'Incident handling',self:'no',manager:'yes',managerRemark:''},
];
it('uses only released report input and reviewed technical answers, grouping by the weakest principle descriptor',()=>{
 const report={statements:[{id:'a',principle:'Collaboration',text:'Asks for others’ input',future:false,agreementPct:50},{id:'b',principle:'Collaboration',text:'Shares decisions',future:true,agreementPct:25},{id:'c',principle:'Delivery',text:'Follows through',future:false,agreementPct:60}],comments:[],remarks:[]};
 const result=developmentItems(report,competencies,'reviewed');expect(result.items.map(i=>[i.label,i.detail])).toEqual([['Collaboration','Shares decisions'],['Planning','Prepare an operational plan']]);expect(result.future.map(i=>i.detail)).toEqual(['Lead cross-unit planning']);expect(result.pool).toEqual(result.items);
 expect(developmentItems(null,competencies,'submitted').pool).toEqual([]);
 expect(developmentItems(null,competencies.map(c=>({...c,manager:c.future?'no' as const:'yes' as const})),'reviewed')).toMatchObject({stretchOnly:true,pool:[{id:'tc:1',label:'Planning'}]});
});
it('drops invented references and unsupported dates and applies source text caps without accepting unrelated goals',()=>{
 const input='```json\n'+JSON.stringify([{area:'Invented',item_ids:['other-employee']},{title:'Practical planning',item_ids:['tc:0','invented'],experience:'Lead a small planning cycle',exposure:'Ask a mentor for feedback',education:'Study a planning method',dueOn:'2099-12-31'},{area:'Second',item_ids:['tc:0'],experience:'x'.repeat(1500)}])+'\n```';
 const result=parseDevelopmentSuggestions(input,new Set(['tc:0']),2);expect(result).toEqual([{area:'Practical planning',title:'Practical planning',itemIds:['tc:0'],onJob:'Lead a small planning cycle',fromOthers:'Ask a mentor for feedback',formalLearning:'Study a planning method'},{area:'Second',title:'Second',itemIds:['tc:0'],onJob:'x'.repeat(1000),fromOthers:'',formalLearning:''}]);expect(result.some(g=>'dueOn' in g)).toBe(false);
 expect(parseDevelopmentSuggestions(input,new Set(['tc:0']),1)).toHaveLength(1);expect(parseDevelopmentSuggestions(input,new Set(['tc:0']),0)).toEqual([]);expect(parseDevelopmentSuggestions('invalid',new Set(['tc:0']),6)).toEqual([]);
});

it('matches the isolated source goal parser for accepted references, fences, caps and malformed responses',()=>{
 for(const sample of sourceGolden.cases)expect(parseDevelopmentSuggestions(sample.raw,new Set(sample.validIds),sample.maximum)).toEqual(sample.expected);
});
