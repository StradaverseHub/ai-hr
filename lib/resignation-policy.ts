import {addNotice,defaultSettlementPolicy,type NoticePeriod,type SettlementPolicy} from './lifecycle-v9-calculator';
/** The existing final-pay notice owner uses future final confirmation to establish probation; a missing date does not. */
export function resignationNotice(facts:{jobGrade:string;employmentType:string;finalConfirmationDate?:string|null;noticeBefore?:NoticePeriod|null;noticeAfter?:NoticePeriod|null},today:string,policy:SettlementPolicy=defaultSettlementPolicy()){
 const probation=!!facts.finalConfirmationDate&&facts.finalConfirmationDate>today;
 const band=policy.bands.find(b=>b.grades.some(g=>g.toUpperCase()===facts.jobGrade.toUpperCase()));
 const period=(probation?facts.noticeBefore:facts.noticeAfter)??band?.[facts.employmentType==='contract'?'contract':probation?'probation':'permanent']??policy.defaultNotice;
 return{earliestLastDay:addNotice(today,period,policy.noticeDays==='working'),noticeLabel:`${period.value} ${period.unit}${period.value===1?'':'s'}`};
}

/** Same six-decimal increment-percent policy as Personnel's employee-master projection; money stays in exact cents. */
export function resignationBaseIncrement(previous:string|null|undefined,next:string|null|undefined):string|null{
 const cents=(value:string|null|undefined):number|null=>{if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))return null;const result=Math.round(Number(value)*100);return Number.isSafeInteger(result)?result:null;};
 const before=cents(previous),after=cents(next);if(before===null||before<=0||after===null)return null;
 return String(Number(((after-before)/before*100).toFixed(6)));
}
