import 'server-only';
import type {SessionContext} from '@/db/client';
import {probationAdministrationOptions,probationLetterTemplates} from '@/packs/probation/service';
import type {NamedOption} from './recipients';

export type ProbationLetterChoice = NamedOption & { state: 'draft' | 'published' | 'retired'; version: number; outcome: string };
/**
 * Probation letter templates of one company the viewer configures, through the existing Probation template service
 * (letters and their signing routing stay with Probation; lane D owns signing routing). One company per request: the
 * requested one, else the first. Null when the viewer configures no Probation company.
 */
export async function probationLetterChoices(ctx:SessionContext,companyId?:string):Promise<{companies:NamedOption[];company:NamedOption;templates:ProbationLetterChoice[]}|null>{
 let options:Awaited<ReturnType<typeof probationAdministrationOptions>>;
 try{options=await probationAdministrationOptions(ctx);}
 catch(error){if(error instanceof Error&&error.name==='ProbationError')return null;throw error;}
 const company=options.companies.find(c=>c.id===companyId)??options.companies[0];if(!company)return null;
 const definitions=await probationLetterTemplates(ctx,company.id),seen=new Set<string>(),templates:ProbationLetterChoice[]=[];
 // Rows are ordered by key, then newest version first: the first row of each key is its latest version.
 for(const definition of definitions){if(seen.has(definition.key))continue;seen.add(definition.key);
  if(definition.state!=='retired')templates.push({id:definition.key,name:definition.data.name,state:definition.state,version:definition.version,outcome:definition.data.outcome});}
 return {companies:options.companies,company,templates};
}
