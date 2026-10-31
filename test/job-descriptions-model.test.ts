import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM, normalizedJobCode, validateAnswers, validateDefinition, validateInput, type JobInput } from '../packs/job-descriptions/model';
const input = (patch: Partial<JobInput> = {}): JobInput => ({ companyId: 'company', jobCode: 'FIN-001', title: 'Finance Analyst', owner: 'Finance owner', org: {}, answers: { purpose: [{ purpose: 'Maintain accurate reporting' }] }, effectiveOn: '', reviewOn: '', reason: '', reviewerIds: [], approverId: '', ...patch });
describe('linked JA / JD / JS contract', () => {
    it('normalizes equivalent company Job IDs without collapsing distinct IDs', () => { expect(normalizedJobCode('  ﬁn-001  ')).toBe('FIN-001'); expect(normalizedJobCode('a   b')).toBe('A B'); expect(normalizedJobCode('FIN-002')).not.toBe(normalizedJobCode('FIN-001')); });
    it('keeps incomplete drafts editable but requires document control at submission', () => { expect(() => validateInput(input({ answers: {} }), DEFAULT_FORM)).not.toThrow(); expect(() => validateInput(input(), DEFAULT_FORM, true)).toThrow(/owner, reviewers, approver/); });
    it('rejects partial or non-100 time distributions only at submission and accepts omitted percentages', () => { const answers = { tasks: [{ task: 'Review invoices', time: 50 }, { task: 'Reconcile ledgers', time: 40 }] }; expect(() => validateAnswers(DEFAULT_FORM, answers)).not.toThrow(); expect(() => validateAnswers(DEFAULT_FORM, answers, true)).toThrow(/100%/); expect(() => validateAnswers(DEFAULT_FORM, { tasks: [{ task: 'Review invoices', time: 100 }, { task: 'Reconcile ledgers' }] }, true)).toThrow(/100%/); expect(() => validateAnswers(DEFAULT_FORM, { tasks: [{ task: 'Review invoices' }] }, true)).toThrow(/purpose/); const valid = { ...answers, purpose: [{ purpose: 'Accurate ledgers' }], tasks: [{ task: 'Review invoices', time: 60 }, { task: 'Reconcile ledgers', time: 40 }] }; expect(() => validateAnswers(DEFAULT_FORM, valid, true)).not.toThrow(); });
    it('rejects type confusion, unknown fields, overlong values and impossible dates', () => { expect(() => validateAnswers(DEFAULT_FORM, { tasks: [{ time: '100' }] })).toThrow(/Time/); expect(() => validateAnswers(DEFAULT_FORM, { tasks: [{ hiddenPay: 100 }] })).toThrow(/Unknown/); expect(() => validateAnswers(DEFAULT_FORM, { purpose: [{ purpose: 'a'.repeat(12001) }] })).toThrow(/Invalid/); expect(() => validateAnswers(DEFAULT_FORM, { analysisDetails: [{ analysisOn: '2025-02-30' }] })).toThrow(/Invalid/); expect(() => validateInput(input({ effectiveOn: '2026-05-02', reviewOn: '2026-05-01' }), DEFAULT_FORM)).toThrow(/precede/); });
    it('types optional extensions and prevents removing or retyping attached template sections', () => { const def = structuredClone(DEFAULT_FORM); def.version = 2; def.sections[0].fields.push({ id: 'evidenceScore', label: 'Evidence score', type: 'number', required: true, custom: true }); expect(validateDefinition(def).version).toBe(2); expect(() => validateAnswers(def, { analysisDetails: [{ evidenceScore: '4' }] })).toThrow(/Evidence score/); expect(() => validateAnswers(def, { analysisDetails: [{}], purpose: [{ purpose: 'Clear role' }] }, true)).toThrow(/Evidence score/); def.sections[0].fields[0].type = 'number'; expect(() => validateDefinition(def)).toThrow(/standard field/); });
    it('has every computed UI and template caption in all supported locales', () => { for (const locale of ['en', 'ms', 'zh', 'vi', 'th', 'ta']) {
        const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8')).jobDescriptions;
        for (const section of DEFAULT_FORM.sections) {
            expect(messages.sections[section.id], `${locale}/${section.id}`).toBeTruthy();
            for (const field of section.fields)
                expect(messages.fields[section.id][field.id], `${locale}/${section.id}.${field.id}`).toBeTruthy();
        }
        for (const status of ['draft', 'submitted', 'approved', 'inactive'])
            expect(messages.statuses[status]).toBeTruthy();
    } });
});
it('projects a successor by stable ID and type while preserving the approved answer object',async()=>{
 const {projectJobAnswers}=await import('../packs/job-descriptions/model');
 const old=structuredClone(DEFAULT_FORM);old.sections[0].fields.push({id:'custom',label:'Custom',type:'number',required:false,custom:true},{id:'removed',label:'Removed',type:'text',required:false,custom:true});
 const next=structuredClone(DEFAULT_FORM);next.version=2;next.sections[0].fields.push({id:'custom',label:'Custom',type:'text',required:true,custom:true},{id:'added',label:'Added',type:'date',required:false,custom:true});
 const answers={analysisDetails:[{analyst:'Analyst',custom:42,removed:'Keep in original history'}]};
 expect(projectJobAnswers(old,next,answers)).toEqual({analysisDetails:[{analyst:'Analyst'}]});expect(answers.analysisDetails[0].custom).toBe(42);expect(answers.analysisDetails[0].removed).toBe('Keep in original history');
});
it('localizes validation field guidance while keeping diagnostic and custom captions stable',async()=>{
 const{jobErrorGuidance}=await import('../app/(app)/admin/job-descriptions/error-guidance');const{JobDocumentError}=await import('../packs/job-descriptions/model');const{createTranslator}=await import('next-intl');for(const locale of ['en','ms','zh','vi','th','ta']){const messages=JSON.parse(readFileSync(new URL(`../messages/${locale}.json`,import.meta.url),'utf8'));const t=createTranslator({locale,messages,namespace:'jobDescriptions',onError:error=>{throw error;}});const result=jobErrorGuidance(new JobDocumentError('Complete Job purpose: Overall job purpose'),t);expect(result).toContain(t('fields.purpose.purpose'));expect(jobErrorGuidance(new JobDocumentError('Complete Custom section: HR Custom Label'),t)).toContain('HR Custom Label');expect(jobErrorGuidance(new Error('private SQL detail'),t)).toBe(t('saveFailed'));}
});
