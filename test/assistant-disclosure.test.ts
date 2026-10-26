/** Sealed source fingerprint cases, authored UNRUN. No DB, network or provider. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantSourceDigest, openAssistantDisclosure, sealAssistantDisclosure, type AssistantDisclosureBinding } from '../lib/ai/assistant-disclosure';
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
