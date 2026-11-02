import type {ProbationCaseView} from '@/packs/probation/service';
import {useTranslations} from 'next-intl';
export function ProbationFacts({view}:{view:ProbationCaseView}){
 const t=useTranslations('probation'),f=view.record.facts;
 const values=[['employee',f.employeeName],['employeeCode',f.employeeCode],['company',f.companyName],['department',f.department],['businessUnit',f.businessUnit],['title',f.title],['grade',view.record.gradeAtStart],['startOn',view.record.startOn],['endOn',view.record.endOn],['plan',t('planMonths',{months:view.record.planMonths})],['extensions',t('extensionCount',{count:view.record.extensionCount,max:view.record.config.maxExtensions})]] as const;
 return <dl className="probation-facts">{values.map(([key,value])=><div key={key}><dt>{t('facts.'+key)}</dt><dd>{value||'—'}</dd></div>)}</dl>;
}
