import {getTranslations} from 'next-intl/server';
import {LETTER_APPROVAL_LABEL_KEYS,type LetterApprovalLabels} from '@/lib/letter-approval-ui';
import {templateLabels} from '../templates/labels';
export async function approvalLabels(){
 const t=await getTranslations('letters.approval'),e=await getTranslations('letters.errors'),template=await templateLabels();
 const errors:Record<string,string>={...template.errors,...Object.fromEntries((['invalid','permission','stale','conflict','configuration','unavailable','state','reasonRequired'] as const).map(key=>[key,e(key)])),signatureRequired:t('signatureRequired')};
 return {copy:Object.fromEntries(LETTER_APPROVAL_LABEL_KEYS.map(key=>[key,t(key)])) as LetterApprovalLabels,picker:template.picker,document:template.editor,errors};
}
