/** AI v2 Phase 2, P2-5 — "what does our policy say about …?", declared in the semantic model.
 *
 * One read, my_policy_handbook, over core/handbook/ask.ts readPoliciesInForce: the APPROVED version in force of each
 * company policy that applies to the caller's own company (an administrator also those of the companies they
 * administer), split into numbered paragraphs, with the citation a reply must give. Never a draft, a version waiting
 * for approval, a value read from the text or an approval (migration 0971 row-level security).
 *
 * The paragraphs are the company's own approved policy wording, published to its employees: product content an HR
 * administrator wrote for everyone in the company to read, not a person's own free text and not an HR record. They are
 * therefore disclosed as written (`full`); the harness still screens every byte it sends for identifiers. Pure
 * declarations. */
import {provenanceField} from './entities-explain';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'|'screen'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const HANDBOOK_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'policy_handbook',label:'Company policies',
  meaning:'The approved company policies in force that apply to the caller\'s company, in the company\'s own words, as numbered paragraphs with the citation to give.',
  module:null,sensitivity:'ordinary',audience:'self',rls:'own_employment',
  owners:['core/handbook/ask.ts#readPoliciesInForce'],
  ruleVersion:null,relations:[],page:'/policies',
  fields:[
   f('matchedTopic','boolean','full','Whether any paragraph shares words with the question\'s topic; false means the policies below are listed without a match.'),
   f('policies','list','full','The approved policies in force, the best match first.',{of:[
    f('title','label','full','The policy\'s title.'),
    f('area','enum','full','The policy\'s area.',{values:['leave','attendance','claims','allowances','people','other']}),
    f('version','integer','full','The approved version in force.'),
    f('effectiveFrom','date','full','The date this version has applied from.'),
    f('citation','label','full','What to cite: the policy title, version and paragraph numbers.'),
    f('paragraphs','list','full','The paragraphs that answer the topic (or the first ones), with their numbers.',{of:[
     f('paragraph','integer','full','The paragraph number within this version.'),
     f('text','published_text','full','The paragraph exactly as the company approved and published it to the people it applies to.')]}),
    f('paragraphCount','integer','full','How many paragraphs this version has.')]}),
   f('otherPolicies','list','full','Titles of the other approved policies in force for the caller, not shown above.'),
   provenanceField]},
] satisfies SemanticEntity[]);

export const HANDBOOK_READS:readonly SemanticRead[]=freeze([
 {name:'my_policy_handbook',entity:'policy_handbook',
  purpose:'What the company\'s own approved policies say, for the asking person\'s company: the approved version in force of each policy, as numbered paragraphs. Use it for "what is our mileage rate", "how many days of annual leave do I get under the handbook", "what does the policy say about …" questions. Answer only from the paragraphs returned and cite the policy title, version and paragraph; if they do not answer it, say so. Never a draft.',
  input:[{name:'topic',identifier:false,optional:true,schema:{type:'string',maxLength:200,description:'A few words for what the person asks about, for example "mileage claims" or "annual leave".'}}]},
] satisfies SemanticRead[]);
