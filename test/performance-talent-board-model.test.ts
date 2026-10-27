import { expect,it } from 'vitest';
import { defaultPolicy,policySchema } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { boardMove,boardSummary,fixed1,roundHalfEven,talentBoxSettings,talentMoveAllowance,talentMoveCapBreach,talentMoveUsage,type CapPerson } from '../packs/performance/onehr/talent-board-model';

const normal={UA:5,BE:10,ME:70,AE:10,OU:5};
const person=(id:string,performance:'UA'|'BE'|'ME'|'AE'|'OU',potential:'Low'|'Mid'|'High')=>({id,performance,potential});

it('defaults to the source layout and no ceiling, and a policy without the block parses unchanged',()=>{
 const policy=defaultPolicy(framework);
 expect(talentBoxSettings(policy)).toEqual({grid:9,moveCap:null});
 expect(policySchema.parse(policy)).not.toHaveProperty('talentBox');
 expect(talentBoxSettings({talentBox:{grid:15,moveCap:{enabled:false,pct:10}}})).toEqual({grid:15,moveCap:null});
 expect(talentBoxSettings({talentBox:{moveCap:{enabled:true,pct:10}}})).toEqual({grid:9,moveCap:{pct:10}});
});

it('counts how many to move per category from the cells on screen, half to even',()=>{
 const rows=Array.from({length:10},(_,i)=>person(`p${i}`,'ME','Mid'));
 const s=boardSummary(rows,9,normal);
 expect(s.placed).toBe(10);
 expect(s.cells.find(c=>c.key==='mid|Mid')).toMatchObject({category:'Solid Core',count:10,pct:100,reference:49});
 expect(s.cells.find(c=>c.key==='high|High')).toMatchObject({category:'Super Star',count:0,reference:2.25});
 // PIP 12.75% of 10 → 1, Solid Core 64% → 6, Star 21% → 2, Super Star 2.25% → 0.
 expect(s.deltas.map(d=>[d.category,d.target,d.delta])).toEqual([['PIP/Improvement',1,1],['Solid Core',6,-4],['Star',2,2],['Super Star',0,0]]);
 expect(boardSummary(rows,9,null)).toMatchObject({hasReference:false,deltas:[]});
 expect(roundHalfEven(2.5)).toBe(2);expect(roundHalfEven(3.5)).toBe(4);expect(roundHalfEven(0.225)).toBe(0);
 expect(fixed1(6.25)).toBe('6.2');expect(fixed1(6.75)).toBe('6.8');expect(fixed1(100/3)).toBe('33.3');
});

it('reads a person’s own five-band category for the tabs and the cell’s own label for the grid',()=>{
 // High potential + UA sits in the nine-box Solid Core cell but is a PIP/Improvement person.
 const s=boardSummary([person('a','UA','High')],9,normal);
 expect(s.cells.find(c=>c.key==='low|High')).toMatchObject({category:'Solid Core',count:1});
 expect(s.categoryCounts).toMatchObject({'PIP/Improvement':1,'Solid Core':0});
 expect(boardSummary([person('a','UA','High')],15,normal).cells).toHaveLength(15);
});

it('points the movement arrow along the diagonal of the grid that is showing',()=>{
 expect(boardMove({...person('a','AE','High'),from:{performance:'ME',potential:'Mid'}},9)).toBe('up');
 expect(boardMove({...person('a','BE','Mid'),from:{performance:'ME',potential:'Mid'}},9)).toBe('down');
 expect(boardMove({...person('a','AE','Low'),from:{performance:'ME',potential:'Mid'}},9)).toBe('down');
 expect(boardMove({...person('a','OU','Mid'),from:{performance:'AE',potential:'Mid'}},9)).toBeNull();
 expect(boardMove({...person('a','OU','Mid'),from:{performance:'AE',potential:'Mid'}},15)).toBe('up');
});

it('rounds the allowance half up, never below one, and nothing for an empty unit',()=>{
 expect([0,1,5,10,15,25,35].map(n=>talentMoveAllowance(n,10))).toEqual([0,1,1,1,2,3,4]);
});

it('refuses the move that would spend an allowance past the cap and keeps corrections and returns free',()=>{
 const unmoved=(_i:number):CapPerson=>({companyId:'x',from:{performance:'ME',potential:'Mid'},current:{performance:'ME',potential:'Mid'}});
 const moved=(_i:number):CapPerson=>({companyId:'x',from:{performance:'ME',potential:'Mid'},current:{performance:'AE',potential:'Mid'}});
 const rows=[moved(0),...Array.from({length:19},(_,i)=>unmoved(i+1))];// 20 people at 10% → cap 2, one used
 expect(talentMoveUsage(rows,10).get('x')).toEqual({headcount:20,used:1,cap:2,left:1});
 expect(talentMoveCapBreach(rows,rows[1],{performance:'AE',potential:null},10)).toBeNull();// the Nth move
 const full=[moved(0),moved(1),...rows.slice(2)];
 expect(talentMoveCapBreach(full,full[2],{performance:'AE',potential:null},10)).toEqual({headcount:20,used:2,cap:2,left:0});// N+1
 expect(talentMoveCapBreach(full,full[2],{performance:null,potential:'Low'},10)).toBeNull();// ME/Low is still Solid Core
 expect(talentMoveCapBreach(full,full[0],{performance:'OU',potential:null},10)).toBeNull();// already re-categorised
 expect(talentMoveCapBreach(full,full[0],{performance:'ME',potential:null},10)).toBeNull();// moving back
 expect(talentMoveCapBreach(full,{...full[2],companyId:'y'},{performance:'AE',potential:null},10)).toBeNull();// another unit
});
