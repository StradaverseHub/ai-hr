import { z } from 'zod';
import { assertOverallRemark } from './journey-model';
export type ManagerCommandFacts={stage:string;self:boolean;manager:boolean;moderator:boolean;finalized:boolean;kpis:{id:string;title:string}[];competencyStatus:string;plan:{id:string;status:string;goals:{id:string;area:string}[]}|null};
export type ManagerCommand=
 |{action:'confirm_kpi';id:string}
 |{action:'confirm_performance'}
 |{action:'approve_competencies'}
 |{action:'comment_career';text:string}
 |{action:'comment_plan';text:string}
 |{action:'comment_goal';id:string;text:string}
 |{action:'close_plan';heldOn:string|null;text:string|null};
const normal=(text:string)=>text.trim().normalize('NFKC').toLocaleLowerCase('en');
function uniqueTarget(name:string,targets:{id:string;label:string}[]){const matches=targets.filter(t=>normal(t.label)===normal(name));if(matches.length!==1)throw Error('Name one currently assigned item exactly.');return matches[0].id;}
/** Only the human's explicit, whole-message instruction can confirm. Model output is never input here. */
export function readManagerCommand(text:string,facts:ManagerCommandFacts):ManagerCommand|null{
 const words=text.trim();let command:ManagerCommand|null=null;
 if(/^(?:please\s+)?(?:confirm|approve)\s+(?:all\s+)?(?:kpi results|performance assessment)\.?$/i.test(words))command={action:'confirm_performance'};
 else if(/^(?:please\s+)?approve\s+(?:the\s+)?competency review\.?$/i.test(words))command={action:'approve_competencies'};
 else{
  const kpi=words.match(/^(?:please\s+)?(?:confirm|lock)\s+kpi\s*:\s*(.+?)\.?$/i),career=words.match(/^career comment\s*:\s*([\s\S]+)$/i),plan=words.match(/^plan comment\s*:\s*([\s\S]+)$/i),goal=words.match(/^goal comment\s*:\s*(?:\[([^\]]+)\]|([^:]+))\s*:\s*([\s\S]+)$/i),close=words.match(/^(?:please\s+)?close\s+(?:the\s+)?development plan(?:\s+on\s+(\d{4}-\d{2}-\d{2}))?(?:\s*:\s*([\s\S]+))?\.?$/i);
  if(kpi)command={action:'confirm_kpi',id:uniqueTarget(kpi[1],facts.kpis.map(k=>({id:k.id,label:k.title})))};
  else if(career)command={action:'comment_career',text:career[1].trim()};
  else if(plan)command={action:'comment_plan',text:plan[1].trim()};
  else if(goal)command={action:'comment_goal',id:uniqueTarget(goal[1]??goal[2],facts.plan?.goals.map(g=>({id:g.id,label:g.area}))??[]),text:goal[3].trim()};
  else if(close)command={action:'close_plan',heldOn:close[1]?z.iso.date().parse(close[1]):null,text:close[2]?.trim()??null};
 }
 if(!command)return null;
 if(facts.self||!facts.manager&&!facts.moderator)throw Error('Only an assigned reviewer can use this action.');if(facts.finalized)throw Error('This assessment is read-only.');
 if(command.action==='confirm_kpi'||command.action==='confirm_performance'){if(facts.stage!=='moderation')throw Error('Confirm KPI results from the KPI moderation step.');}
 else if(command.action==='approve_competencies'){if(facts.stage!=='competency'||!facts.manager||facts.competencyStatus!=='submitted')throw Error('The competency review is not awaiting your approval.');}
 else{
  if(facts.stage!=='career')throw Error('Use the development-plan review step for this action.');
  if('text' in command&&command.text!=null)z.string().trim().min(1).max(command.action==='comment_goal'?1000:4000).parse(command.text);
  if(command.action==='comment_plan'){if(!facts.manager)throw Error('Only the line manager writes the overall plan remark.');assertOverallRemark(command.text);}
  if(command.action!=='comment_career'&&facts.plan?.status!=='shared')throw Error('Only a shared, open development plan accepts this action.');
 }
 return command;
}
