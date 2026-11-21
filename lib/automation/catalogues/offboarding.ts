/** Resignation catalogue. V9 leaver-case triggers remain owned by V9; these events belong to module off's resignation subject. */
import type {AutomationModuleCatalogue} from '../catalogue';
export const OFFBOARDING_LETTER_TRIGGERS = ['signRequest','sentBack','released'] as const;
export const OFFBOARDING_NOTIFY_TRIGGERS = [...OFFBOARDING_LETTER_TRIGGERS,'offerDue'] as const;
export const OFFBOARDING_DECISION_TRIGGERS = ['submitted','rejected','offerDeclined'] as const;
export const OFFBOARDING_OFFER_TRIGGERS = ['retention','offerAccepted'] as const;
export const OFFBOARDING_OFFER_FACT_TRIGGERS = [...OFFBOARDING_OFFER_TRIGGERS,'offerDeclined','rejected','offerDue'] as const;
export const OFFBOARDING_POSTING_EVENTS = ['Transfer','Promotion','Increment','Confirmation','Salary Adjustment','Employment Type Change','Termination'] as const;
export const OFFBOARDING_POSTING_FIELDS = ['title','grade','salary'] as const;
export const OFFBOARDING_AUTOMATION_CATALOGUE: AutomationModuleCatalogue = {
 module:'off',label:'Offboarding',
 triggers:[
  {id:'submitted',label:'A resignation is submitted'}, {id:'retention',label:'A retention offer is submitted'},
  {id:'accepted',label:'Resignation is accepted'}, {id:'rejected',label:'An approval is rejected'},
  {id:'offerDue',label:'An offer reply is nearly due'}, {id:'offerAccepted',label:'The employee accepts the offer'},
  {id:'offerDeclined',label:'The employee declines, or the offer lapses'}, {id:'withdrawn',label:'The employee withdraws'},
  {id:'signRequest',label:'A letter needs a review, approval or signature'}, {id:'sentBack',label:'A letter is sent back for changes'},
  {id:'released',label:'A letter is signed and released'},
 ],
 skipWhen:[{id:'never',label:'Never skip'},{id:'caseClosed',label:'The case is already closed'},{id:'noPbp',label:'Retired PBP condition — reconcile named routing'}],
 conditionFields:[
  {id:'businessGroup',label:'Business group',ops:['is','isNot']},{id:'company',label:'Company',ops:['is','isNot']},
  {id:'department',label:'Department',ops:['is','isNot']},{id:'jobTitle',label:'Job title',ops:['is','isNot']},{id:'jobGrade',label:'Job grade',ops:['is','isNot']},
  {id:'baseIncrement',label:'Base increment %',ops:['gte','lte'],triggers:OFFBOARDING_OFFER_FACT_TRIGGERS},
  {id:'document',label:'Document',ops:['is','isNot'],triggers:OFFBOARDING_LETTER_TRIGGERS},
  {id:'letterStep',label:'Letter step',ops:['is','isNot'],values:['Review','Approve','Sign','Update','Released'],triggers:OFFBOARDING_LETTER_TRIGGERS},
 ],
 stepTypes:[{id:'sendEmail',label:'Send an email'},{id:'notify',label:'Notify someone'},{id:'generateDocument',label:'Generate a document'},
  {id:'requestDecision',label:'Request resignation decision'},{id:'requestApproval',label:'Request approval'},
  {id:'startOffboarding',label:'Start offboarding case'},{id:'createPosting',label:'Create Personnel posting'}],
 recipients:[{id:'employee',label:'The employee',kind:'role'},{id:'directSuperior',label:'Their Direct Superior',kind:'role'},
  {id:'routing',label:'A routing',kind:'routing'},{id:'group',label:'An assignment group',kind:'group'},
  {id:'person',label:'Named people',kind:'person'},{id:'pendingStep',label:'Whoever’s letter step is pending',kind:'pending'}],
 mergeFields:[
  {key:'employee.id',label:'Employee ID',group:'Profile'},{key:'employee.name',label:'Full name',group:'Profile'},
  {key:'company.name',label:'Company',group:'Organisation'},{key:'employee.businessGroup',label:'Business group',group:'Organisation'},
  {key:'employee.department',label:'Department',group:'Organisation'},{key:'employee.position',label:'Position',group:'Organisation'},
  {key:'employee.grade',label:'Grade',group:'Organisation'},{key:'employee.supervisor',label:'Direct superior',group:'Organisation'},
  {key:'employee.salary',label:'Current base salary',group:'Pay'},
  ...[['caseId','Resignation case ID'],['submittedDate','Submitted date'],['lastDay','Last working day'],['reason','Reason']].map(([key,label])=>({key:'resignation.'+key,label,group:'Resignation'})),
  ...[['title','New job title'],['grade','New grade'],['salary','New base salary'],['effectiveDate','Effective date']].map(([key,label])=>({key:'retention.'+key,label,group:'Retention offer',triggers:OFFBOARDING_OFFER_FACT_TRIGGERS})),
  {key:'retention.replyBy',label:'Reply-by date',group:'Retention offer',triggers:['offerDue','offerDeclined']},
  ...[['name','Document name'],['action','What is being asked'],['where','Where to do it'],['by','Sent back by'],['why','Reason it was sent back']].map(([key,label])=>({key:'letter.'+key,label,group:'Letter',triggers:OFFBOARDING_LETTER_TRIGGERS})),
  {key:'today',label:'Today',group:'General'},
 ],
};
