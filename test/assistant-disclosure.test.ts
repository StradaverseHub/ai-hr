/** Sealed source fingerprint cases, authored UNRUN. No DB, network or provider. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantSourceDigest, openAssistantDisclosure, openAssistantAnswerDisclosure, sealAssistantDisclosure, type AssistantDisclosureBinding } from '../lib/ai/assistant-disclosure';
import { decryptSecret, encryptSecret } from '../lib/ai/crypto';
beforeEach(() => { vi.stubEnv('AI_CONFIG_SECRET', 'fictional-disclosure-key-never-production'); });
afterEach(() => vi.unstubAllEnvs());
const fixture = () => {
  const binding: AssistantDisclosureBinding = { tenantId: randomUUID(), userId: randomUUID(), exchangeId: randomUUID(),
    question: 'Fictional own status?', answer: 'Fictional canonical answer sentinel.' };
  const input = { employment_id: randomUUID() };
  const reads = [{ name: 'employee_profile', input, digest: assistantSourceDigest({ ok: true, employee: { name: 'PRIVATE_ROW_SENTINEL' } }) }];
  return { binding, reads, input };
};
const aad = (b: AssistantDisclosureBinding) => JSON.stringify(['ai-hr.assistant-disclosure.v1', b.tenantId, b.userId, b.exchangeId]);
describe('Assistant historical disclosure receipt', () => {
  it('round-trips immutable captured lookup inputs without storing result rows or readable fingerprints', () => {
    const { binding, reads, input } = fixture();
    const token = sealAssistantDisclosure(binding, reads)!;
    expect(token).toBeTruthy(); expect(token).not.toContain('PRIVATE_ROW_SENTINEL'); expect(token).not.toContain(reads[0].digest);
    const opened = openAssistantDisclosure(binding, token)!;
    expect(opened).toEqual(reads); expect(Object.isFrozen(opened)).toBe(true); expect(Object.isFrozen(opened[0].input)).toBe(true);
    input.employment_id = randomUUID(); expect(opened[0].input).not.toEqual(input);
    expect(decryptSecret(token, aad(binding))).not.toContain('PRIVATE_ROW_SENTINEL');
    expect(sealAssistantDisclosure(binding, reads)).not.toBe(token);
  });
  it.each(['tenantId', 'userId', 'exchangeId', 'question', 'answer'] as const)('refuses swapped %s', field => {
    const { binding, reads } = fixture(); const token = sealAssistantDisclosure(binding, reads)!;
    expect(openAssistantDisclosure({ ...binding, [field]: randomUUID() }, token)).toBeNull();
  });
  it('rejects legacy/empty/corrupt/noncanonical tokens and absent custody even after warm encryption', () => {
    const { binding, reads } = fixture(); const token = sealAssistantDisclosure(binding, reads)!;
    for (const value of [undefined, null, '', 'junk', token + '!', token + '=', token.slice(0, -8), token.replace(/^./, token[0] === 'A' ? 'B' : 'A')])
      expect(openAssistantDisclosure(binding, value)).toBeNull();
    vi.stubEnv('AI_CONFIG_SECRET', '');
    expect(openAssistantDisclosure(binding, token)).toBeNull(); expect(sealAssistantDisclosure(binding, reads)).toBeNull();
  });
  it('refuses incomplete, excessive, non-JSON and malformed source evidence', () => {
    const { binding, reads } = fixture();
    expect(sealAssistantDisclosure(binding, undefined)).toBeNull();
    expect(openAssistantDisclosure(binding, sealAssistantDisclosure(binding, []))).toEqual([]);
    expect(sealAssistantDisclosure(binding, Array.from({ length: 129 }, () => reads[0]))).toBeNull();
    expect(sealAssistantDisclosure(binding, [{ ...reads[0], digest: 'not-a-fingerprint' }])).toBeNull();
    expect(sealAssistantDisclosure(binding, [{ ...reads[0], input: { x: Infinity } }])).toBeNull();
    expect(sealAssistantDisclosure(binding, [{ ...reads[0], input: { x: 'x'.repeat(33_000) } }])).toBeNull();
    expect(sealAssistantDisclosure({ ...binding, answer: '' }, reads)).toBeNull();
  });
  it('refuses authenticated but unknown or extra-field receipt formats rather than guessing upgrades', () => {
    const { binding, reads } = fixture(); const token = sealAssistantDisclosure(binding, reads)!;
    const original = JSON.parse(decryptSecret(token, aad(binding)));
    for (const changed of [{ ...original, v: 2 }, { ...original, body: '0'.repeat(64) }, { ...original, extra: true },
      { ...original, reads: [{ ...reads[0], extra: true }] }, { ...original, reads: [{ ...reads[0], digest: null }] }])
      expect(openAssistantDisclosure(binding, encryptSecret(JSON.stringify(changed), aad(binding)))).toBeNull();
  });
});

describe('sealed source-owned specialist job references',()=>{
 it('captures only an internal module-work job reference and binds it to the actual exchange principal',()=>{
  const {binding}=fixture(),moduleJobId=randomUUID(),source={name:'my_module_work',input:{module:'org'},digest:assistantSourceDigest({ok:true,module:'org'}),moduleJobId};
  const token=sealAssistantDisclosure(binding,[source])!;expect(token).toBeTruthy();expect(token).not.toContain(moduleJobId);expect(openAssistantDisclosure(binding,token)).toEqual([source]);
  expect(openAssistantDisclosure({...binding,userId:randomUUID()},token)).toBeNull();
  for(const invalid of [{...source,name:'employee_profile'},{...source,moduleJobId:'model-provided-version'},{...source,promotionId:randomUUID()}])expect(sealAssistantDisclosure(binding,[invalid])).toBeNull();
 });
});


describe('source-bound conversational plans',()=>{
 it('keeps legacy receipts card-only and authenticates a v2 plan without exposing model prose',()=>{
  const {binding,reads}=fixture(),plan={version:1 as const,mode:'clarify' as const,slot:'period' as const};
  const legacy=sealAssistantDisclosure(binding,reads)!;
  expect(openAssistantAnswerDisclosure(binding,legacy)).toEqual({reads,plan:null});
  const token=sealAssistantDisclosure(binding,reads,plan)!;
  expect(openAssistantAnswerDisclosure(binding,token)).toEqual({reads,plan});
  expect(openAssistantDisclosure(binding,token)).toEqual(reads);
  expect(token).not.toContain('period');
  expect(openAssistantAnswerDisclosure({...binding,question:'Another question'},token)).toBeNull();
 });
 it('refuses authenticated v2 plan corruption and never upgrades arbitrary terminal text',()=>{
  const {binding,reads}=fixture();
  const token=sealAssistantDisclosure(binding,reads,{version:1,mode:'clarify',slot:'employment'})!;
  const original=JSON.parse(decryptSecret(token,aad(binding)));
  for(const plan of [{version:1,mode:'clarify',slot:'salary'}, {version:1,mode:'clarify',slot:'period',answer:'unverified HR fact'},
   {version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:0,fact:0,value:999}]}]){
   expect(openAssistantAnswerDisclosure(binding,encryptSecret(JSON.stringify({...original,plan}),aad(binding)))).toBeNull();
  }
 });
 it('allows no-source clarification, but source references remain nominations requiring replay',()=>{
  const {binding}=fixture();
  const token=sealAssistantDisclosure(binding,[],{version:1,mode:'clarify',slot:'leave_type'})!;
  expect(openAssistantAnswerDisclosure(binding,token)?.plan?.mode).toBe('clarify');
  const nominated={version:1 as const,mode:'answer' as const,blocks:[{kind:'fact' as const,read:0,card:0,fact:0}]};
  const nominatedToken=sealAssistantDisclosure(binding,[],nominated)!;
  expect(openAssistantAnswerDisclosure(binding,nominatedToken)?.plan).toEqual(nominated);
  // Encryption authenticates the nominated plan. It intentionally does not adjudicate nonexistent
  // current-source facts; the fresh-source answer owner must reject that reference on replay.
 });
});
