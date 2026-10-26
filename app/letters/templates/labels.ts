import {getTranslations} from 'next-intl/server';
import {localeNames} from '@/i18n/config';
import type {LetterTemplateFormLabels} from '@/components/letters/template-form';
import type {LetterEditorLabels} from '@/components/letters/rich-editor';
import type {ConditionLabels} from '@/components/letters/condition-builder';
import type {LetterChoiceLabels} from '@/components/letters/choice-picker';
export async function templateLabels():Promise<LetterTemplateFormLabels>{
 const t=await getTranslations('letters.templates'),f=await getTranslations('letters.fields');
 const formKeys=['code','name','category','language','effectiveFrom','letterhead','signatory','noLetterhead','unavailableChoice','fields','fieldHelp','remove','none','save','submit','saving','versionHelp','presentationHelp','limit'] as const;
 const editorKeys=['body','toolbar','bold','italic','underline','paragraph','heading','bulletList','orderedList','table','addRow','deleteRow','addColumn','deleteColumn','deleteTable','undo','redo','field','insertField','conditional','then','otherwise','editCondition','apply','cancel','invalid','pasteHelp'] as const;
 const conditionKeys=['operator','field','value','currency','present','equals','after','greater','all','any','not','add','remove'] as const,pickerKeys=['search','find','more','choose','loading','empty','error'] as const;
 return {...Object.fromEntries(formKeys.map(key=>[key,t(`form.${key}`)])) as Pick<LetterTemplateFormLabels,typeof formKeys[number]>,languages:localeNames,
  errors:{...Object.fromEntries((['invalid','permission','stale','conflict','configuration','unavailable'] as const).map(key=>[key,f(`errors.${key}`)])),...Object.fromEntries((['invalidField','state','selfApproval','reasonRequired','missingField','limit'] as const).map(key=>[key,t(`errors.${key}`)]))},
  picker:Object.fromEntries(pickerKeys.map(key=>[key,t(`picker.${key}`)])) as LetterChoiceLabels,
  editor:{...Object.fromEntries(editorKeys.map(key=>[key,t(`editor.${key}`)])) as Omit<LetterEditorLabels,'condition'>,condition:Object.fromEntries(conditionKeys.map(key=>[key,t(`condition.${key}`)])) as ConditionLabels}};
}
