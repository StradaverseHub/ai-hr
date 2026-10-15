import { it,expect } from 'vitest';
import { competencyGuidance } from '../packs/performance/onehr/competency-guide-model';
import { literalCompetencyReflection } from '../packs/performance/onehr/review-command-model';
const items=[{id:'lo',text:'Current planning',skillTitle:'Planning',principle:'Technical',future:false},{id:'hi',text:'Future planning',skillTitle:'Planning',principle:'Technical',future:true}];
it('names unfinished work before the reflection and preserves a reflection written first',()=>{
 const draft={kind:'competency_self' as const,answers:{lo:{answer:'yes' as const,remark:''},hi:{answer:null,remark:''}},remark:''};
 expect(competencyGuidance(items,draft)).toContain('one competency is still to answer: Planning');expect(competencyGuidance(items,draft)).not.toContain('Last step');
 expect(competencyGuidance(items,{...draft,remark:'My saved reflection.'})).toContain('Your remark is saved.');
});
it('asks one grounded overall question and does not disclose score thresholds or invent achievements',()=>{
 const draft={kind:'competency_self' as const,answers:{lo:{answer:'yes' as const,remark:''},hi:{answer:'yes' as const,remark:''}},remark:''};
 const full=competencyGuidance(items,draft);expect(full).toContain('in 50-100 words');expect(full).toContain('fully demonstrating Planning');expect(full).not.toMatch(/75%|High potential|score/);
 expect(competencyGuidance(items,{...draft,answers:{...draft.answers,hi:{answer:'no',remark:''}}})).toContain('growing into the next level of Planning');
 expect(competencyGuidance(items,{...draft,answers:{...draft.answers,lo:{answer:'no',remark:''}}})).toContain('Planning as Developing');
 expect(competencyGuidance(items,draft,true)).not.toContain('Last step');expect(competencyGuidance(items,{...draft,remark:'I practised planning.'})).toContain('Nothing has been submitted');
});
it('proposes literal reflection text without writing it and reads saved text without inventing a draft',()=>{
 const facts={text:'',targets:[{id:'lo',label:'Current planning'}],draft:{kind:'competency_self' as const,answers:{lo:{answer:'yes' as const,remark:'Existing words.'}},remark:''}};
 const text='Draft reflection: Current planning: I planned the weekly team work.';
 const result=literalCompetencyReflection(text,{...facts,text});expect(result).toMatchObject({ok:true,changed:false,reflection:{id:'lo',text:'I planned the weekly team work.',originalNote:'Existing words.',isDraft:true}});expect(facts.draft.answers.lo.remark).toBe('Existing words.');
 const read='Read saved reflection: Current planning';expect(literalCompetencyReflection(read,{...facts,text:read})).toMatchObject({reflection:{text:'Existing words.',isDraft:false}});
 for(const words of ['Add an example','[Insert your note]','']){const text=`Draft reflection: Current planning: ${words}`;expect(()=>literalCompetencyReflection(text,{...facts,text})).toThrow();}
 expect(()=>literalCompetencyReflection(text,{...facts,text,draft:{...facts.draft,answers:{lo:{answer:null,remark:''}}}})).toThrow(/first/);
});
