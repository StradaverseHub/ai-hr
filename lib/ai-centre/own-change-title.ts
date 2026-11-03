/** AI v2 W2 — the specific title of an own claim or profile change card prepared in chat: "Travel claim, RM 42.60,
 * Oct 31", "Cancel Travel claim, RM 42.60, Oct 31", "Change your home address", "Change your bank account to Maybank,
 * ending 4321", in the person's locale (aiCentre.conversation.claimSubmitTitle, claimCancelTitle, profileAddressTitle,
 * profileEmergencyTitle, profileDependantTitle and profileBankTitle in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the claim type name, the date incurred and the amount exactly as the
 * claims service normalised or stored it, the kind of profile change, the bank name and the last four digits. Nothing
 * is computed here; a card without those facts keeps its generic title (null). Dates are formatted as calendar dates,
 * in UTC, so no time zone can move them by a day. Pure. */
export type OwnChangeTitleKey='claimSubmitTitle'|'claimCancelTitle'|'profileAddressTitle'|'profileEmergencyTitle'|'profileDependantTitle'|'profileBankTitle';
export const OWN_CHANGE_TITLE_KEYS:readonly OwnChangeTitleKey[]=Object.freeze(['claimSubmitTitle','claimCancelTitle','profileAddressTitle','profileEmergencyTitle','profileDependantTitle','profileBankTitle']);
type Translate=(key:OwnChangeTitleKey,values:Record<string,string|number>)=>string;
type FormatDate=(date:Date)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string}>;
 facts?:Readonly<{claimType?:string;incurredOn?:string;amount?:string;profileChange?:string;bankName?:string;accountEnding?:string}>}>;

export const OWN_CHANGE_TITLE_DATE={day:'numeric',month:'short',timeZone:'UTC'} as const;
const DATE=/^\d{4}-\d{2}-\d{2}$/,AMOUNT=/^\d{1,9}\.\d{2}$/;
const PROFILE_TITLE:Readonly<Record<string,OwnChangeTitleKey>>=Object.freeze({address:'profileAddressTitle',emergency_contact:'profileEmergencyTitle',dependant:'profileDependantTitle'});
/** "Travel Claim" already says claim: the title adds the word itself, so a trailing "claim" in the name is dropped. */
const typeName=(name:string)=>name.replace(/\s+claims?$/i,'').trim()||name;

export function ownChangeCardTitle(body:TitledProposal,t:Translate,formatDate:FormatDate):string|null{
 const facts=body.facts??{},action=body.what.action;
 if(action==='claims.submit'||action==='claims.cancel'){
  const {claimType,incurredOn,amount}=facts;
  if(!claimType||!incurredOn||!amount||!DATE.test(incurredOn)||!AMOUNT.test(amount))return null;
  return t(action==='claims.submit'?'claimSubmitTitle':'claimCancelTitle',{claimType:typeName(claimType),amount,date:formatDate(new Date(incurredOn+'T00:00:00.000Z'))});
 }
 if(action==='ess.profile.request'){
  if(facts.profileChange==='bank')return facts.bankName&&facts.accountEnding&&/^\d{4}$/.test(facts.accountEnding)?t('profileBankTitle',{bankName:facts.bankName,ending:facts.accountEnding}):null;
  const key=facts.profileChange?PROFILE_TITLE[facts.profileChange]:undefined;
  return key?t(key,{}):null;
 }
 return null;
}
