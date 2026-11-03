/** Spec v20 (the naming rule: "AI Centre" on every user-visible surface, "Noveri" only on the How it works page): the
 * fixed replies and fixed reply notes of a conversation never call it "the Assistant", in any of the six locales.
 * Covered: the harness's fixed replies (core/harness/spec.ts sensitive and replyChecks), the conversation reply's own
 * strings (aiCentre.conversation: the route note, who prepared a card, the provider errors) and the stopped-turn notes
 * (assistant.stop_*). Product and settings labels that name the feature are not fixed replies and are not covered.
 * Thai, Tamil and Vietnamese wording is pending native review. Pure: reads the catalogues from disk. */
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC} from '../core/harness/spec';

const LOCALES=['en','ms','zh','vi','ta','th'] as const;
/** The word each locale used for "the Assistant" before v20. */
const ASSISTANT:Readonly<Record<typeof LOCALES[number],RegExp>>={en:/assistant/i,ms:/pembantu/i,zh:/助手|助理/u,vi:/trợ lý/iu,ta:/உதவியாள/u,th:/ผู้ช่วย/u};
/** "AI Centre" as each locale names it in the navigation (messages/ai-centre/<locale>.json nav.aiCentre). */
const CENTRE:Readonly<Record<typeof LOCALES[number],string>>={en:'AI Centre',ms:'Pusat AI',zh:'AI 中心',vi:'Trung tâm AI',ta:'AI மையம்',th:'ศูนย์ AI'};
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8')) as Record<string,any>;
function strings(value:unknown,path:string,out:[string,string][]=[]):[string,string][]{
 if(typeof value==='string')out.push([path,value]);
 else if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))strings(child,path+'.'+key,out);
 return out;
}
const S=HARNESS_SPEC.sensitive,R=HARNESS_SPEC.replyChecks;

describe('fixed replies say "the AI Centre", never "the Assistant"',()=>{
 it('in the harness\'s own fixed replies',()=>{
  const fixed:Record<string,string>={routeReply:S.routeReply,caseClause:S.caseClause,crisisReply:S.crisisReply,workplaceHarmReply:S.workplaceHarmReply,
   instructionOverrideReply:S.instructionOverrideReply,fallbackReply:R.fallbackReply,budgetReply:R.budgetReply,unavailableFigure:R.unavailableFigure};
  for(const [name,text] of Object.entries(fixed))expect(text,name).not.toMatch(ASSISTANT.en);
  for(const name of ['routeReply','workplaceHarmReply','instructionOverrideReply'])expect(fixed[name],name).toMatch(/\b[Tt]he AI Centre\b/);
 });
 it.each(LOCALES)('in the conversation reply strings and stopped-turn notes (%s)',locale=>{
  const catalogue=json(`messages/ai-centre/${locale}.json`),centre=catalogue.aiCentre.conversation,main=json(`messages/${locale}.json`);
  const stops=Object.fromEntries(Object.entries(main.assistant as Record<string,unknown>).filter(([key])=>key.startsWith('stop_')));
  const found=[...strings(centre,'aiCentre.conversation'),...strings(stops,'assistant')];
  expect(found.length,locale).toBeGreaterThan(40);
  expect(found.filter(([,text])=>ASSISTANT[locale].test(text)).map(([path])=>path),locale).toEqual([]);
  // The renamed strings name the AI Centre as the navigation does.
  expect(catalogue.nav.aiCentre,locale).toBe(CENTRE[locale]);
  for(const path of ['routed','errors.provider_error']){
   const text:string=path.split('.').reduce<any>((node,key)=>node?.[key],centre);
   // Tamil declines the name (மையத்தால், by the centre): its stem is checked.
   expect(text,locale+' '+path).toContain(locale==='ta'?'AI மைய':CENTRE[locale]);
  }
  for(const key of ['stop_refusal','stop_other','stop_tool_use','stop_turn_cap'])expect(stops[key],locale+' '+key).toContain(CENTRE[locale]);
 });
});
