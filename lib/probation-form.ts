import {PROBATION_CRITERIA,type Assessment} from './probation-model';
export type ProbationCriterion={id:string;section:'role'|'principles';title:string;weight:number;standard:string;behaviours:string[];prompt:string};
/**
 * Review and approval routing on the form version (handoff B3; owner mockup screen 10). After the core steps of each Part
 * (the Line Manager's signed assessment, then the employee's acknowledgement), the rows run by `order`, lower first;
 * rows sharing an order run one after another in the order listed. Editable only by saving a new version (published
 * versions are immutable), and a case keeps the form version it started on, so a Part keeps the routing it opened with.
 * `who` names who resolves the step: 'hod' (Head of Department) and 'pbp' (People Business Partner) resolve through
 * the existing holder rules, delegation and duplicate-role policy. The other shapes are reserved for routings
 * ('routing:<id>'), assignment groups ('group:<id>'), named people ('user:<id>') and the Direct Superior
 * ('superior'); the signing runtime does not resolve them yet, so a form naming them cannot be saved.
 */
export const PROBATION_APPROVAL_ACTIONS=['review','approve','approve_sign'] as const;
export type ProbationApprovalAction=typeof PROBATION_APPROVAL_ACTIONS[number];
export const PROBATION_APPROVAL_SIGNING_WHO=['hod','pbp'] as const;
export type ProbationApprovalRow={id:string;order:number;action:ProbationApprovalAction;who:string};
export type ProbationApprovalRouting=Record<'1'|'2'|'3',ProbationApprovalRow[]>;
export type ProbationFormDuplicateRolePolicy={mode:'escalate'|'sign_once'|'named_alternate';alternateUserId?:string|null};
export type ProbationForm={targetGrades?:string[];version:number;name:string;criteria:ProbationCriterion[];ratingLabels:string[];bands:{min:number;band:number;label:string}[];employeeCommentsRequired:boolean;
 /** Absent on versions saved before form routing: those cases keep the published signing routes configuration. */
 approvals?:ProbationApprovalRouting;
 /** Absent: the signing routes configuration's policy applies. */
 duplicateRolePolicy?:ProbationFormDuplicateRolePolicy};
/** Today's default route as form rows: Part 3 goes to the Head of Department, then the People Business Partner. */
export function defaultProbationApprovals():ProbationApprovalRouting{return{'1':[],'2':[],'3':[{id:'hod',order:1,action:'approve_sign',who:'hod'},{id:'pbp',order:2,action:'approve_sign',who:'pbp'}]};}
/** The rows of one Part in the order they run: by order, then as listed. */
export function probationApprovalChain(rows:readonly ProbationApprovalRow[]):ProbationApprovalRow[]{return rows.map((row,index)=>({row,index})).sort((a,b)=>a.row.order-b.row.order||a.index-b.index).map(item=>item.row);}
export function probationApprovalIssues(form:Pick<ProbationForm,'approvals'|'duplicateRolePolicy'>):string[]{
 const issues:string[]=[];
 if(form.duplicateRolePolicy!==undefined){const policy=form.duplicateRolePolicy;if(!policy||!['escalate','sign_once','named_alternate'].includes(policy.mode))issues.push('policy:mode');else if(policy.mode==='named_alternate'&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(policy.alternateUserId??''))issues.push('policy:alternate');}
 if(form.approvals===undefined)return issues;
 for(const part of ['1','2','3'] as const){
  const rows=form.approvals?.[part];if(!Array.isArray(rows)||rows.length>10){issues.push(part+':rows');continue;}
  // Part 3 decides the outcome: someone independent of the Line Manager must approve it (signing rule).
  if(part==='3'&&!rows.length)issues.push('3:approval_required');
  const ids=new Set<string>(),who=new Set<string>();
  for(const row of rows){
   if(!/^[a-z][a-z0-9_]{0,39}$/.test(row?.id??'')||ids.has(row.id))issues.push(part+':id');ids.add(row?.id);
   if(!Number.isInteger(row?.order)||row.order<1||row.order>9)issues.push(part+':'+row?.id+':order');
   if(!PROBATION_APPROVAL_ACTIONS.includes(row?.action))issues.push(part+':'+row?.id+':action');
   else if(row.action!=='approve_sign')issues.push(part+':'+row.id+':action_unsupported');
   if(typeof row?.who!=='string'||!/^(hod|pbp|superior|(routing|group|user):[A-Za-z0-9_-]{1,80})$/.test(row.who))issues.push(part+':'+row?.id+':who');
   else if(!(PROBATION_APPROVAL_SIGNING_WHO as readonly string[]).includes(row.who))issues.push(part+':'+row.id+':who_unsupported');
   else if(who.has(row.who))issues.push(part+':'+row.id+':who_duplicate');
   who.add(row?.who);
  }
 }
 return [...new Set(issues)];
}

const guidance=[
 ['kpi','KPI Achievement Progress','Progress against agreed KPIs, targets and deliverables',[], 'What results demonstrate progress against the acknowledged Week 1 KPIs?'],
 ['knowledge','Job Knowledge & Problem Solving','Application of technical and role knowledge',[],'Which work examples show effective knowledge and problem solving?'],
 ['customer','We Focus on Customer Delight','The customer is at the centre of everything we do. Without our customers, we are nothing. When we exceed their expectations, profits will naturally follow.',['We think ahead and anticipate customer needs before being asked.','We always go the extra mile for our customers, even to the point of surprising them.','We listen carefully to our customers to understand deeply, and then respond quickly.'],'What stakeholder need was understood or anticipated? What value or service improvement resulted?'],
 ['action','We have a Bias for Action','Actions speak louder than words. We execute what we say and commit to what we do. This is commitment in action.',['We do not wait for perfect conditions to take action.','We take ownership and proactively solve problems without waiting for instructions.','We accept that fast decisions sometimes lead to mistakes, and we course-correct quickly when needed.'],'Where did the employee take timely ownership, remove obstacles or follow through without repeated prompting?'],
 ['standards','We Always Set High Standards','We never settle for less. To be a company of winners, we aim higher, move faster, and expect better. This mindset demands that we constantly evolve, improve, and raise the bar.',['We have a relentless pursuit of doing better every time.','We benchmark against the world’s best and aim for top-tier performance.','We have a zero tolerance for mediocrity. Good just is not good enough.'],'What evidence shows quality, accuracy, discipline, attention to detail or continuous improvement?'],
 ['positivity','We Embrace Challenges with Positivity','When we aim high, challenges are expected. But we face them with resilience and perseverance, knowing that no obstacle is impossible and every challenge has its answer.',['We stay calm under pressure, even when things do not go as planned.','We see challenges as opportunities to stretch, improve, and grow stronger.','We learn from failure and come back wiser.'],'How did the employee respond to change, pressure, setbacks or unfamiliar work?'],
 ['talent','We Hire & Develop Talents with the Right Ability & Fit','Great companies are built on great talent. Each individual should strengthen and elevate the whole. The right ability, the right motivation, the right fit – this is our formula for hiring and development.',['We hire for proven ability and future potential – not just paper credentials.','We invest in top talent for critical roles, knowing that expertise and experience are worth the premium.','We actively develop our people to grow their skills, unlock potential, and raise performance.'],'How did the employee learn, apply feedback or share knowledge? For managers, how were team members coached?'],
 ['respect','We Disagree with Respect, Then Commit in Unity','We believe in speaking up with honesty and respect, even when it is difficult. It is not just about strong opinions, but about contributing thoughtfully. Once a decision is made, we set aside our differences, align as one, and move forward with full commitment.',['We engage in open, honest debate so the best ideas can emerge.','We speak up with honesty and respect, even when our views are uncomfortable or unpopular.','Once a decision is made, we commit fully and do not reopen settled discussions.'],'How did the employee express a different view respectfully and support the final decision?'],
 ['transparency','We Uphold Transparency','Transparency means saying things clearly and truthfully so there is no guessing, no confusion, and nothing hidden. It is how we build trust, create alignment, and make better decisions together.',['We value visibility and transparency of information by communicating with brutal openness.','We explain the why to key advocates to help drive alignment.','We speak up when something feels wrong.'],'What risks, mistakes or constraints were communicated early? Were stakeholders kept accurately informed?'],
] as const;
export const DEFAULT_PROBATION_FORM:ProbationForm={version:1,name:'Probation Evaluation Form v22.9.26',criteria:guidance.map(([id,title,standard,behaviours,prompt],i)=>({id,title,standard,behaviours:[...behaviours],prompt,section:i<2?'role':'principles',weight:PROBATION_CRITERIA.find(c=>c.id===id)!.weight})),ratingLabels:['Unacceptable','Below Expectations','Meets Expectations','Above Expectations','Outstanding'],bands:[{min:451,band:5,label:'Outstanding'},{min:351,band:4,label:'Above Expectations'},{min:251,band:3,label:'Meets Expectations'},{min:151,band:2,label:'Below Expectations'},{min:100,band:1,label:'Unacceptable'}],employeeCommentsRequired:false,approvals:defaultProbationApprovals()};
export function validateProbationForm(form:ProbationForm){
 if(!Number.isInteger(form.version)||form.version<1||!form.name.trim()||form.criteria.length<1||form.criteria.length>30||form.ratingLabels.length!==5)throw Error('Check the form version, criteria and five rating labels.');
 const ids=new Set<string>();let total=0;
 for(const c of form.criteria){if(!/^[a-z][a-z0-9_]{0,39}$/.test(c.id)||ids.has(c.id)||!c.title.trim()||!['role','principles'].includes(c.section)||!Number.isInteger(c.weight)||c.weight<1||c.weight>100||!c.standard.trim()||!c.prompt.trim())throw Error('Each criterion needs a unique ID, title, guidance and whole percentage weight.');ids.add(c.id);total+=c.weight;}
 if(total!==100||form.criteria.filter(c=>c.section==='role').reduce((n,c)=>n+c.weight,0)!==50)throw Error('Role and Leadership Principle weights must each total 50%.');
 const routing=probationApprovalIssues(form);
 if(routing.some(issue=>issue.endsWith(':who_unsupported')))throw Error('Approval steps can resolve to the Head of Department or the People Business Partner. Routings, assignment groups, named people and the Direct Superior cannot sign probation reviews yet.');
 if(routing.some(issue=>issue.endsWith(':action_unsupported')))throw Error('Approval steps approve and sign. Review-only and approve-without-signature steps cannot run on probation reviews yet.');
 if(routing.includes('3:approval_required'))throw Error('Part 3 needs at least one approval step: someone other than the Line Manager approves the outcome.');
 if(routing.length)throw Error('Check the approval steps: a unique ID, an order from 1 to 9, an action and who for each step, each person or role at most once per Part.');
 const bands=[...form.bands].sort((a,b)=>a.min-b.min);if(bands.length!==5||bands[0].min!==100||new Set(bands.map(b=>b.band)).size!==5||bands.some((b,i)=>!Number.isInteger(b.min)||b.min<100||b.min>500||b.band!==i+1||!b.label.trim())||bands.some((b,i)=>i>0&&b.min<=bands[i-1].min))throw Error('Provide five ordered score bands covering 1.00–5.00.');
}
export function scoreProbationForm(form:ProbationForm,assessment:Assessment){
 let sectionA=0,sectionB=0;
 for(const c of form.criteria){const n=assessment[c.id]?.rating;if(n===null||n===undefined)return null;if(!Number.isInteger(n)||n<1||n>5)throw Error('Select a whole rating from 1 to 5.');if(c.section==='role')sectionA+=n*c.weight;else sectionB+=n*c.weight;}
 const hundredths=sectionA+sectionB;return{sectionA,sectionB,hundredths,band:[...form.bands].sort((a,b)=>b.min-a.min).find(b=>hundredths>=b.min)!.band};
}
export function probationFormIssues(form:ProbationForm,assessment:Assessment,kpiEvidence=false){return form.criteria.flatMap(c=>{const r=assessment[c.id];return !r||r.rating===null?[c.id+':unrated']:!Number.isInteger(r.rating)||r.rating<1||r.rating>5?[c.id+':invalid_rating']:(r.rating<=2||kpiEvidence&&c.id==='kpi')&&!r.evidence.trim()?[c.id+':evidence_required']:[];});}
