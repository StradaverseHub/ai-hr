import {isLocale,type Locale} from '../i18n/config';
import {HomeConfigurationError,validateEmployeeHomePreferences,type EmployeeHomePreferences} from './employee-home';

export type HomePreferenceCommand={command:'reset'}|{command:'save';locale:Locale;preferences:EmployeeHomePreferences};
/** Own cosmetic choices only. Identity, role and the live card catalogue never come from the form. */
export function parseHomePreferenceForm(data:FormData):HomePreferenceCommand{
 const invalid=():never=>{throw new HomeConfigurationError('preferences.form');};
 const single=(key:string)=>{const values=data.getAll(key);if(values.length!==1||typeof values[0]!=='string')return invalid();return values[0];};
 const command=single('command');
 const allowed=command==='reset'?['command']:['command','locale','timeZone','weekStartsOn','cardOrder','hiddenCard'];
 for(const key of data.keys())if(!key.startsWith('$ACTION_')&&!allowed.includes(key))invalid();
 if(command==='reset')return {command};
 if(command!=='save')return invalid();
 const locale=single('locale'),week=single('weekStartsOn'),zone=single('timeZone');
 if(!isLocale(locale)||!/[0-6]/.test(week)||week.length!==1)return invalid();
 return {command,locale,preferences:validateEmployeeHomePreferences({version:1,timeZone:zone||null,
  weekStartsOn:Number(week),cardOrder:data.getAll('cardOrder'),hiddenCards:data.getAll('hiddenCard')})};
}
