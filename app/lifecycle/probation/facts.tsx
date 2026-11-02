import type {ProbationCaseView,ProbationPartView} from '@/packs/probation/service';
import {useTranslations} from 'next-intl';
export function ProbationFacts({view}:{view:ProbationCaseView,ProbationPartView}){
 const t=useTranslations('probation'),f=part?.submittedFacts??view.record.facts,period=part?.submittedPeriod??view.record;
 const values=[['employee',f.employeeName],['employeeCode',f.employeeCode],['company',f.companyName],['department',f.department],['businessUnit',f.businessUnit],['title',f.title],['grade',period.gradeAtStart],['startOn',period.startOn],['endOn',period.endOn],['plan',t('planMonths',{months:view.record.planMonths})],['extensions',t('extensionCount',{count:view.record.extensionCount,max:view.record.config.maxExtensions})]] as const;
 return <dl className="probation-facts">{values.map(([key,value])=><div key={key}><dt>{t('facts.'+key)}</dt><dd>{value||'—'}</dd></div>)}</dl>;
}
