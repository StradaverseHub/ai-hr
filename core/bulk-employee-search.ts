import {sql,type SQL} from 'drizzle-orm';
import {employeeChoiceExactAsciiPredicate} from './employee-choice-ascii';
import {foldEmployeeCode} from '../lib/employee-search';
/** ECMAScript WhiteSpace+LineTerminator (Unicode17), plus the three code separators.
 * These are the complete finite characters removed by /[\\s._-]/g; no general
 * locale class or SQL lowercase substitute is admitted. NUL remains a barrier. */
const separators=sql`U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF._-'`;
/** Supported exact runtime/ASCII needles use native count/page. The existing
 * minimal-cursor compatibility owner remains mandatory for other needles/builds. */
export function bulkEmployeeExactPredicate(name:SQL,code:SQL,q:string):SQL|undefined{
 if(q.includes('\0'))return sql`false`;
 const raw=employeeChoiceExactAsciiPredicate(name,code,q);if(!raw)return undefined;
 const folded=foldEmployeeCode(q);if(!folded)return raw;
 const compact=sql`translate(${code},${separators},'')`;
 const byCode=employeeChoiceExactAsciiPredicate(sql`''::text`,compact,folded);
 return byCode?sql`(${raw} or ${byCode})`:undefined;
}
