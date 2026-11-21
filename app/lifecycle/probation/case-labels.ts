'use client';
import {useTranslations} from 'next-intl';
import type {ProbationCaseView} from '@/packs/probation/service';
import type {ProbationWaiting} from './case-stage';

/**
 * Plain-language names for who a Probation case or part waits on (lane M2; prototype CaseView, WaitNote): the role, the
 * person when one holds the step, and what they are to do. Display only: the waiting step comes from case-stage.ts.
 */
export function useProbationWaitingLabel(view:ProbationCaseView){
 const t=useTranslations('probation'),c=useTranslations('probation.caseView');
 const role=(r:string)=>t.has('roles.'+r)?t('roles.'+r):/^(routing:|group:|people$)/.test(r)?t('roles.approver'):r;
 return (waiting:NonNullable<ProbationWaiting>)=>{
  const person=waiting.holderId?view.holderNames[waiting.holderId]??null:null,roleLabel=waiting.label??role(waiting.role),what=c('what.'+waiting.what);
  return{who:person?roleLabel+' · '+person:roleLabel,what,text:person?c('who',{role:roleLabel,name:person,what}):c('whoNoName',{role:roleLabel,what})};
 };
}
