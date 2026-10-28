import {getTranslations} from 'next-intl/server';
import {templateLabels} from '../templates/labels';
import type {GenerationFormLabels} from '@/components/letters/generation-forms';
export async function generationLabels(){
 const t=await getTranslations('letters.generate'),template=await templateLabels(),keys=['department','branch','hiredFrom','hiredTo','filterHelp','invalidRange','selected','addShown','remove','limit','commonValues','customHelp','create','working','reason'] as const;
 return {form:{...Object.fromEntries(keys.map(key=>[key,t(`form.${key}`)])) as Omit<GenerationFormLabels,'currency'>,currency:template.editor.condition.currency},picker:template.picker,document:template.editor,
  errors:{...template.errors,...Object.fromEntries((['invalid','stale','configuration','conflict','permission','unavailable','state','reasonRequired'] as const).map(key=>[key,t(`errors.${key}`)]))}};
}
