'use client';

import { useState, type ReactNode } from 'react';
import { flushAssessmentDrafts } from './draft-form';

export function AttachmentForm({action,children,id,className}:{action:(data:FormData)=>Promise<void>;children:ReactNode;id?:string;className?:string}) {
 const [error,setError]=useState('');
 return <form id={id} className={className} action={async data=>{
  try{await flushAssessmentDrafts();}catch(e){setError(e instanceof Error?e.message:'');return;}
  setError('');await action(data);
 }}>{error&&<p role="alert" className="text-sm text-destructive">{error}</p>}{children}</form>;
}
