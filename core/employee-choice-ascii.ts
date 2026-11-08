/** One functional Unicode17 ASCII observation. Native build qualification owns
 * actual-runtime parity; these cheap process facts are not an admission proof. */
import {sql,type SQL} from 'drizzle-orm';

export const EMPLOYEE_CHOICE_ASCII_UNICODE='17.0';
export const EMPLOYEE_CHOICE_ASCII_NODES=Object.freeze(['22.23.3','24.22.1'] as const);

/** Keep every non-ASCII barrier. Only default lowercase mappings which can
 * introduce ASCII are U0130 -> i + dot and U212A -> k, plus ASCII A-Z itself.
 * The complete pinned UCD/native proof remains outside application runtime. */
export function employeeChoiceAsciiObservation(value:SQL):SQL{
 return sql`translate(replace(${value},U&'\\0130',U&'i\\0307'),'ABCDEFGHIJKLMNOPQRSTUVWXYZ'||U&'\\212A','abcdefghijklmnopqrstuvwxyzk')`;
}

function qualifiedDefaultIcuProcess(){
 const versions=process.versions,build=process.config.variables;
 // Transitional packaged-runtime policy: qualify BOTH exact releases before
 // deployment. Unknown builds/data configurations retain the exact JS reader.
 if(process.platform!=='linux'||process.arch!=='x64'
  ||!EMPLOYEE_CHOICE_ASCII_NODES.some(node=>versions.node===node)||versions.unicode!==EMPLOYEE_CHOICE_ASCII_UNICODE
  ||!(build.icu_small===false||build.icu_small==='false')
  ||!(build.v8_enable_i18n_support===1||build.v8_enable_i18n_support===true)
  ||build.icu_gyp_path!=='tools/icu/icu-generic.gyp'||build.icu_path!=='deps/icu-small'
  ||(build.icu_default_data_dir??'')!=='')return false;
 // External ICU data is a separate functional configuration, currently not
 // qualified. No files, executable hashes or caller eligibility flags are read.
 return process.env.NODE_ICU_DATA===undefined&&process.env.ICU_DATA===undefined
  &&!process.execArgv.some(value=>value.includes('--icu-data-dir'))
  &&!(process.env.NODE_OPTIONS??'').includes('--icu-data-dir');
}

/** q is the existing prepared JS needle. Undefined preserves the old cursor and
 * JS lower/includes path. This helper owns no scopes, transactions or ordering. */
export function employeeChoiceExactAsciiPredicate(name:SQL,code:SQL,q:string):SQL|undefined{
 if(!q||!/^[\x01-\x7f]+$/.test(q)||/[A-Z]/.test(q)||!qualifiedDefaultIcuProcess())return undefined;
 const needle=sql`convert_to(${q},'UTF8')`;
 return sql`(position(${needle} in convert_to(${employeeChoiceAsciiObservation(name)},'UTF8'))>0
  or position(${needle} in convert_to(${employeeChoiceAsciiObservation(code)},'UTF8'))>0)`;
}
