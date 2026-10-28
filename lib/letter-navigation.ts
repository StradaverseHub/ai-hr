import type {LetterCapability} from './letter-workflow';
type LetterNavItem={href:string;labelKey:string;all:readonly LetterCapability[];any?:readonly LetterCapability[]};
/** Display metadata only. The server supplies the current company-scoped capability rows. */
export const LETTER_NAV_ITEMS=[
 {href:'/letters/templates',labelKey:'letterTemplates',all:[],any:['read','template']},
 {href:'/letters/fields',labelKey:'letterFields',all:[],any:['read','template']},
 {href:'/letters/generate',labelKey:'letterGenerate',all:['read','generate']},
 {href:'/letters/approval',labelKey:'letterApproval',all:['read','approve']},
 {href:'/letters/register',labelKey:'letterRegister',all:['read']},
 {href:'/letters/reports',labelKey:'letterReports',all:['read','report']},
 {href:'/letters/settings',labelKey:'letterSettings',all:[],any:['settings','approve']},
] as const satisfies readonly LetterNavItem[];
export function visibleLetterDestinations(companies:readonly Record<LetterCapability,boolean>[]){
 return (LETTER_NAV_ITEMS as readonly LetterNavItem[]).filter(item=>companies.some(company=>item.all.every(cap=>company[cap])&&(!item.any||item.any.some(cap=>company[cap])))).map(item=>item.href);
}
