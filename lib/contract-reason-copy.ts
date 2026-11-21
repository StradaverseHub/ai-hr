'use client';
import {useTranslations} from 'next-intl';
/** Display only: tenant catalogue labels win; translated native built-ins remain the fallback. */
export function useContractReasonLabel(){
 const t=useTranslations('people.detail.movement.terminationReason');
 return (code:string,label?:string|null)=>label??(t.has(code)?t(code):code.replaceAll('_',' '));
}
