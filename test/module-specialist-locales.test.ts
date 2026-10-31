/** Authored UNRUN. Inventory/placeholder coverage only, not language-quality or specialist correctness proof. */
import {describe,expect,it} from 'vitest';
import {SPECIALIST_FINDINGS} from '../lib/ai/module-specialists';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
const locales={en,ms,zh,ta,th,vi};
const keys=['title','intro','module','create','version','record','nextRecord','evaluations','passing','incomplete','evaluationsUnknown','empty','chooseCandidate','evaluate','evaluateConsent','promote','maxJobs','hours','promotionScope','rollback','runTitle','runIntro','run','chooseModule','findingsTitle','findingsScope','signalsTitle','signalsConsent','signalsTruncated','strategy','strategySummary','strategyDiagnostic','strategyScope','diagnosticTitle','diagnosticState_review','diagnosticState_recorded','diagnosticState_insufficient','diagnosticState_no_followup','diagnosticScope','diagnosticInspect','diagnosticRecord','scopeLegend','scopeUser','scopeCompany','scopeTenant','scopeCompanyChoice','scopeHint','scopeSignalsOnly'];
const placeholders=(value:string)=>[...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match=>match[1]).sort();
describe('closed module specialist locale contract',()=>{
 it('pins source finding uniqueness and the actual current closed inventory',()=>{expect(SPECIALIST_FINDINGS).toHaveLength(56);expect(new Set(SPECIALIST_FINDINGS).size).toBe(SPECIALIST_FINDINGS.length);});
 for(const[locale,messages]of Object.entries(locales)){
  it(`${locale} has every and only the declared finding and control keys`,()=>{const w=messages.assistant.workspace;expect(Object.keys(w.specialistFindings).sort()).toEqual([...SPECIALIST_FINDINGS].sort());expect(Object.keys(w.specialists).sort()).toEqual([...keys].sort());for(const value of [...Object.values(w.specialistFindings),...Object.values(w.specialists)]){expect(typeof value).toBe('string');expect(value.trim().length).toBeGreaterThan(0);}});
  it(`${locale} retains exact named placeholder correspondence`,()=>{const current=messages.assistant.workspace;for(const namespace of ['specialists','specialistFindings'] as const){const actual=current[namespace] as Record<string,string>,reference=en.assistant.workspace[namespace] as Record<string,string>;for(const key of Object.keys(reference))expect(placeholders(actual[key]),`${locale}.${namespace}.${key}`).toEqual(placeholders(reference[key]));}expect(placeholders(current.specialists.record)).toEqual(['module','version']);expect(placeholders(current.specialists.nextRecord)).toEqual(['module','version']);for(const key of ['evaluations','passing','incomplete'] as const)expect(placeholders(current.specialists[key])).toEqual(['count']);});
  if(locale!=='en')it(`${locale} supplies translated sentences instead of English fallback copies`,()=>{const actual=messages.assistant.workspace,reference=en.assistant.workspace;for(const namespace of ['specialists','specialistFindings'] as const){const values=actual[namespace] as Record<string,string>,english=reference[namespace] as Record<string,string>;for(const key of Object.keys(english))expect(values[key],`${locale}.${namespace}.${key}`).not.toBe(english[key]);}});
 }
});
