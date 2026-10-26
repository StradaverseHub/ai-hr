import {getTranslations} from 'next-intl/server';
import {LETTER_APPROVAL_LABEL_KEYS,type LetterApprovalLabels} from '@/lib/letter-approval-ui';
import {templateLabels} from '../templates/labels';
export async function approvalLabels(){
 const t=await getTranslations('letters.approval'),template=await templateLabels();
 const errors:Record<string,string>={...template.errors,signatureRequired:t('signatureRequired')};
 return {copy:Object.fromEntries(LETTER_APPROVAL_LABEL_KEYS.map(key=>[key,t(key)])) as LetterApprovalLabels,picker:template.picker,document:template.editor,errors};
}
