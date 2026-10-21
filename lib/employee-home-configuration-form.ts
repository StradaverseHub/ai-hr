import {locales} from '../i18n/config';
import {HOME_TEMPLATE_FIELDS,HOME_TASK_KINDS,HomeConfigurationError,validateEmployeeHomeConfiguration,type HomeTemplateKey} from './employee-home';

export function parseEmployeeHomeConfigurationForm(data:FormData){
 const templateKeys=Object.keys(HOME_TEMPLATE_FIELDS) as HomeTemplateKey[];
 const optional=new Set(['quickAction','celebrationsEnabled',...templateKeys.map(key=>`template.${key}.enabled`)]);
 const required=['companyId','audienceRole','expectedOrdinal','reason','teamVisibility','celebrationsScope',
  ...HOME_TASK_KINDS.map(kind=>'effort.'+kind),...templateKeys.flatMap(key=>[`template.${key}.priority`,...locales.map(locale=>`template.${key}.${locale}`)])];
 const allowed=new Set([...required,...optional]);
 for(const key of data.keys())if(!key.startsWith('$ACTION_')&&!allowed.has(key))throw new HomeConfigurationError('form');
 const text=(key:string)=>{const value=data.get(key);if(typeof value!=='string')throw new HomeConfigurationError('form');return value;};
 for(const key of required)if(data.getAll(key).length!==1)throw new HomeConfigurationError('form');
 for(const key of optional)if(key!=='quickAction'&&data.getAll(key).length>1)throw new HomeConfigurationError('form');
 const checked=(key:string)=>{if(!data.has(key))return false;if(text(key)!=='on')throw new HomeConfigurationError('form');return true;};
 const integer=(value:string)=>{if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value)))throw new HomeConfigurationError('form');return Number(value);};
 const effortMinutes=Object.fromEntries(HOME_TASK_KINDS.flatMap(kind=>{const raw=text('effort.'+kind).trim();return raw?[[kind,integer(raw)]]:[];}));
 const configuration=validateEmployeeHomeConfiguration({version:1,
  templates:templateKeys.map(key=>({version:1,key,enabled:checked(`template.${key}.enabled`),priority:integer(text(`template.${key}.priority`)),
   text:Object.fromEntries(locales.map(locale=>[locale,text(`template.${key}.${locale}`)]))})),
  quickActions:data.getAll('quickAction'),effortMinutes,teamVisibility:text('teamVisibility'),
  celebrations:{enabled:checked('celebrationsEnabled'),scope:text('celebrationsScope')}});
 return {companyId:text('companyId'),audienceRole:text('audienceRole'),expectedOrdinal:integer(text('expectedOrdinal')),reason:text('reason'),configuration};
}
