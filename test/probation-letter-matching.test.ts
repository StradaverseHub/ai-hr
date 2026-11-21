import {expect,it} from 'vitest';
import {applyReviewedLetterOrganisation} from '../lib/probation-letter-matching';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
it('intersects collapsed company conditions and preserves the original version',()=>{
 const original={...newProbationLetterTemplate('confirm','letter','Letter'),rules:{businessGroup:['parent'],company:['owner']}};
 const converted=applyReviewedLetterOrganisation(original,'owner',{sourceVersionId:'version',sourceVersion:1,reviewed:true,mappings:[{sourceField:'businessGroup',sourceValue:'parent',targetField:'company',targetValues:['owner','other']},{sourceField:'company',sourceValue:'owner',targetField:'company',targetValues:['owner']}]});
 expect(converted.rules.company).toEqual(['owner']);expect(converted.organisationMapping).toBe('personnel-v2');expect(original.rules).toEqual({businessGroup:['parent'],company:['owner']});
});
it('holds incomplete or conflicting reviews instead of silently dropping a saved condition',()=>{
 const original={...newProbationLetterTemplate('confirm','letter','Letter'),rules:{businessUnit:['saved']}};
 expect(()=>applyReviewedLetterOrganisation(original,'owner',{sourceVersionId:'version',sourceVersion:1,reviewed:true,mappings:[]})).toThrow('every saved');
 expect(()=>applyReviewedLetterOrganisation(original,'owner',{sourceVersionId:'version',sourceVersion:1,reviewed:true,mappings:[{sourceField:'businessUnit',sourceValue:'saved',targetField:'company',targetValues:['other']}]})).toThrow('identity kinds');
});
it('warns only when two rule sets can match the same outcome',async()=>{
 const {letterMatchingOverlap}=await import('../lib/probation-letter-matching');
 const a={...newProbationLetterTemplate('confirm','a','A'),rules:{department:['one']}};
 expect(letterMatchingOverlap(a,{...a,id:'b',rules:{department:['two']}})).toBe(false);
 expect(letterMatchingOverlap(a,{...a,id:'b',rules:{}})).toBe(true);
});
