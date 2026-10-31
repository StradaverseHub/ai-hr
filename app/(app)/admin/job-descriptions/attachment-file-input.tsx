'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
/** Refuse oversize multipart bodies before Next's global action transport consumes them. */
export function AttachmentFileInput(){const t=useTranslations('jobDescriptions');const[error,setError]=useState('');return <><input name="attachment" type="file" required accept=".pdf,.docx,.txt,.png,.jpg,.jpeg" className={inputCls} aria-describedby={error?'job-attachment-error':undefined} aria-invalid={!!error} onChange={event=>{const file=event.currentTarget.files?.[0];const message=file&&file.size>2097152?t('errors.attachment'):'';event.currentTarget.setCustomValidity(message);setError(message);}}/>{error&&<span id="job-attachment-error" role="alert" className="text-sm text-destructive">{error}</span>}</>;}
