import type { AssessmentDraft } from './journey-model';
type Item={id:string;text:string;skillTitle?:string;principle:string;future:boolean};
const names=(values:string[])=>values.length<2?values[0]??'':values.slice(0,-1).join(', ')+' and '+values.at(-1);
/** Source competency journey: finish the answers, ask one grounded reflection, then leave submission to the employee. */
export function competencyGuidance(items:Item[],draft:Extract<AssessmentDraft,{kind:'competency_self'}>|null,askedBefore=false){
 if(!items.length)return 'There are no competencies assigned to you in this cycle.';
 if(!draft)return 'Your competency self-assessment is submitted. You can read your saved answers and reflection on the review form.';
 const unanswered=items.filter(item=>!draft.answers[item.id]?.answer),title=(item:Item)=>item.skillTitle??item.text;
 if(unanswered.length){
  const titles=[...new Set(unanswered.map(title))],shown=names(titles.slice(0,4))+(titles.length>4?` and ${titles.length-4} more`:'');
  return `${draft.remark.trim()?'Your remark is saved. Next,':'Before your remark,'} ${unanswered.length===1?'one competency is':`${unanswered.length} competencies are`} still to answer: ${shown}. Choose Demonstrate or Developing for each on the review form.`;
 }
 if(draft.remark.trim())return 'Your competency answers and overall remark are saved in your private draft. Review them, then use Submit competency assessment to confirm. Nothing has been submitted by this conversation.';
 if(askedBefore)return "When you're ready, type your remark on your strengths and development areas -- about 50-100 words -- in the overall remark box, or send it here. Use your own words.";
 const pairs=new Map<string,{current?:Item;future?:Item}>();for(const item of items){const key=JSON.stringify([item.principle,title(item)]),pair=pairs.get(key)??{};pair[item.future?'future':'current']=item;pairs.set(key,pair);}
 const both:string[]=[],now:string[]=[],next:string[]=[];
 for(const pair of pairs.values()){
  const current=pair.current&&draft.answers[pair.current.id]?.answer,future=pair.future&&draft.answers[pair.future.id]?.answer;
  if(current==='yes'&&future==='yes')both.push(title(pair.future!));
  if(current==='no')now.push(title(pair.current!));else if(future==='no'&&(!pair.current||current==='yes'))next.push(title(pair.future!));
 }
 const extra=(both.length?` You rated yourself as fully demonstrating ${names(both)} -- include what shows that.`:'')+(now.length?` You marked ${names(now)} as Developing -- those are your development areas, so say what's getting in the way and what you'll work on.`:next.length?` You're still growing into the next level of ${names(next)} -- that's a good place for your development goals.`:'');
 return "Last step before you submit: in 50-100 words, tell me your strengths and the areas you're still developing -- what's going well, and the challenges."+extra+" It's carried into your development plan, and your manager reads it with your ratings. Type it in the overall remark box (it saves as you type), or send it here. Tip: the STAR method helps -- Situation, Task, Action, Result.";
}
