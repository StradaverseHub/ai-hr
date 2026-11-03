/** AI v2 W1 — the capability catalogue, declared in the semantic model.
 *
 * One harness context read, `product_capabilities`, over the catalogue owner (core/product-context/capability-catalogue.ts):
 * everything the signed-in person can do (registry actions), import, report on or open (destinations) in the product, each
 * with a stable id, a plain title, a kind, an area and whether the AI can prepare it here (`prepare`) or only point to its
 * page (`open`). Derived from code (the action registry, the semantic model's governed actions, the import owners, the
 * report datasets and the destination registry) and filtered by the caller's own permissions; never from guides.
 *
 * Every field is product vocabulary with no personal weight: ids are catalogue keys (never record ids), titles come from the
 * registries and messages, and counts are counts of product capabilities, not of people. So every field is `full`. The
 * harness still discloses the result under these declarations, so an undeclared key never leaves (fail closed). Pure
 * declarations; nothing here reads or grants. */
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const CAPABILITY_KINDS=['action','import','report','page'] as const;
export type CapabilityKind=(typeof CAPABILITY_KINDS)[number];
export const CAPABILITY_MODES=['prepare','open'] as const;
export type CapabilityMode=(typeof CAPABILITY_MODES)[number];
/** Plain product areas, so the model can group and filter without module codes. */
export const CAPABILITY_AREAS=['people','organisation','leave','attendance','claims','payroll','performance','rewards','lifecycle','approvals',
 'self_service','knowledge','notifications','testing','reports','settings','security','ai','general'] as const;
export type CapabilityArea=(typeof CAPABILITY_AREAS)[number];

const area=f('area','enum','full','The product area it belongs to.',{values:CAPABILITY_AREAS});
export const CATALOGUE_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'product_capability',label:'What you can do here',
  meaning:'What the signed-in person can do, import, report on or open in this product, from the product\'s own registries and filtered by their permissions; for each, whether the assistant can prepare it in chat or only point to its page.',
  module:null,sensitivity:'ordinary',audience:'self',rls:'own_module_scope',
  owners:['core/product-context/capability-catalogue.ts#capabilityCatalogueFor','core/product-context/actions.ts#actionCatalogueFor','lib/product-context/destinations.ts#destinationsFor'],
  ruleVersion:null,relations:[],page:'/assistant',
  fields:[
   f('entries','list','full','Matching things this person can do, import, report on or open.',{of:[
    f('id','label','full','Stable catalogue id. For an action, the id suggest_action takes.'),
    f('kind','enum','full','action (a change), import (a file upload), report or page.',{values:CAPABILITY_KINDS}),
    f('mode','enum','full','prepare: the assistant can prepare it here for the person to confirm. open: only its page can, so point to it.',{values:CAPABILITY_MODES}),
    area,
    f('title','label','full','Its plain title.'),
    f('page','label','full','Where it is done or seen, when the person can open that page; absent for actions, whose card carries the page.'),
    f('template','boolean','full','The import page offers a template to download.'),
    f('action','label','full','For an import that is also a change this person may make: the id suggest_action takes for its card.'),
   ]}),
   f('areas','list','full','With no filter: every area this person has something in, with how many of each kind and a few example titles.',{of:[
    area,
    f('actions','integer','full','Actions in the area.'),f('imports','integer','full','Imports in the area.'),
    f('reports','integer','full','Reports in the area.'),f('pages','integer','full','Pages in the area.'),
    f('examples','list','full','Up to three example titles, those the assistant can prepare first.'),
   ]}),
  ]},
] satisfies SemanticEntity[]);

/** Declared like the step 4 reads, but offered as a context tool: it holds nothing about any person, only what the caller
 * may use in the product. Not in TERAS_READS (those are the explainer and metric capabilities the kit regenerates). */
export const CATALOGUE_READS:readonly SemanticRead[]=freeze([
 {name:'product_capabilities',entity:'product_capability',
  purpose:'Everything the signed-in person can do, import, report on or open in this product, from its own registries and their permissions, never guessed: each entry\'s kind, title, area and mode (prepare: you prepare it here; open: done on its page). With no filter: counts per area and what you can prepare. Never offer anything it does not list.',
  input:[
   {name:'kind',identifier:false,optional:true,schema:{type:'string',enum:[...CAPABILITY_KINDS],description:'Only this kind.'}},
   {name:'area',identifier:false,optional:true,schema:{type:'string',maxLength:60,description:'Words for the area or subject, such as payroll history or leave; matched against titles and areas.'}},
  ]},
] satisfies SemanticRead[]);
