import {getTranslations} from 'next-intl/server';
import {LETTER_SETTINGS_LABEL_KEYS,type LetterSettingsLabels} from '@/lib/letter-settings-ui';
import {templateLabels} from '../templates/labels';
export async function settingsLabels(){
 const t=await getTranslations('letters.settings'),e=await getTranslations('letters.errors'),base=await templateLabels();
 const errors:Record<string,string>={...base.errors,...Object.fromEntries((['invalid','permission','stale','conflict','configuration','unavailable','state','reasonRequired'] as const).map(key=>[key,e(key)]))};
 return {version:(number:number)=>t('version',{number}),copy:Object.fromEntries(LETTER_SETTINGS_LABEL_KEYS.map(key=>[key,t(key)])) as LetterSettingsLabels,common:{category:base.category,letterhead:base.letterhead,signatory:base.signatory,none:base.none,noLetterhead:base.noLetterhead,unavailableChoice:base.unavailableChoice},picker:base.picker,errors};
}
