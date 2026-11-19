'use client';
import {useTranslations} from 'next-intl';
import {probationEmailFields,probationEmailFieldGroups} from '@/lib/automation/probation-email-definition';
export type EmailBuilderCopy=(key:string,values?:Record<string,string|number>)=>string;
export function useProbationEmailCopy(){
 const t=useTranslations('probationEmailBuilder');
 const copy:EmailBuilderCopy=(key,values)=>t('ui.'+key,values);
 const fieldLabel=(key:string)=>t('fields.'+key.replaceAll('.','_'));
 const fields=probationEmailFields.map(field=>({...field,label:fieldLabel(field.key)}));
 const fieldGroups=probationEmailFieldGroups.map(group=>({label:t('groups.'+group.label),fields:group.fields.map(field=>({...field,label:fieldLabel(field.key)}))}));
 return {copy,fields,fieldGroups};
}
