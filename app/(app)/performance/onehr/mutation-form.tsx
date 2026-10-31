'use client';
import {useState,type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import {flushAssessmentDrafts} from './draft-form';
/** Save the current remark before a decision or lock can navigate away or make it immutable. */
export function AssessmentMutationForm({action,children,className}:{action:(data:FormData)=>Promise<void>;children:ReactNode;className?:string}){
 const [error,setError]=useState(''),t=useTranslations('onehr');
 return <form className={className} action={async data=>{try{await flushAssessmentDrafts();setError('');}catch{setError(t('talentPerson.failed'));return;}await action(data);}}>{children}{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}</form>;
}
