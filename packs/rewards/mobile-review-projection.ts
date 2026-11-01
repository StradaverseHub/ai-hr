import type {CalculatedEntry} from './engine';
import {block} from '../../lib/mobile-api/pack-form';
/** Accepts already-admitted records. Explicitly omits every money-bearing source and derived field when hidden. */
export function mobileRewardPersonBlock(r:CalculatedEntry,hidden:boolean){
 const currency=(c:number)=>new Intl.NumberFormat('en-MY',{style:'currency',currency:'MYR'}).format(c/100);
 const rows:[string,unknown][]=[['Employee code',r.source.employeeCode],['Grade',r.source.grade],['Performance',r.facts.performance],['Talent',r.facts.talent],['Classification reviewed',r.facts.reviewed]];
 if(hidden)rows.push(['Reward amounts','Handled separately by the authorized senior-rewards reviewer']);
 else rows.push(['Current basic',currency(r.source.basicCents)],['Current role',r.recommendation.currentRoleSummary],['Proposed role',r.recommendation.proposedRoleSummary],['Proposed grade',r.recommendation.promotionGrade],['Merit increment',currency(r.meritCents)],['Promotion increment',currency(r.promotionCents)],['Special increment',currency(r.specialCents)],['New basic',currency(r.newBasicCents)],['Bonus',currency(r.bonusCents)],['Lump sum',currency(r.lumpCents)],['Reason',r.recommendation.reason],['Increment eligibility',r.incrementReason],['Bonus eligibility',r.bonusReason]);
 return block(r.id,r.source.name,rows);
}
