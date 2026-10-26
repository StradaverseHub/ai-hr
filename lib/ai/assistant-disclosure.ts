/** Server-only source fingerprints for historical answer reauthorization. No source rows are stored.
 * A receipt authenticates the trusted command's source binding, not model truth or effect authority.
 */
import { createHash } from 'node:crypto';
import { captureAgentReadBatch, serializeAgentReadResult } from './agent-read-batch';
import { decryptSecret, encryptSecret, isSecretStorable } from './crypto';

export const ASSISTANT_DISCLOSURE_VERSION = 1;
export const ASSISTANT_DISCLOSURE_LIMITS = Object.freeze({ reads: 128, tokenBytes: 786_432, plainBytes: 524_288 });
export type AssistantDisclosureBinding = Readonly<{ tenantId: string; userId: string; exchangeId: string; question: string; answer: string }>;
export type AssistantSourceRead = Readonly<{ name: string; input: unknown; digest: string }>;
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const assistantSourceDigest = (outcome: unknown) => digest(serializeAgentReadResult(outcome));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const aad = (binding: AssistantDisclosureBinding) => JSON.stringify(['ai-hr.assistant-disclosure.v1', binding.tenantId, binding.userId, binding.exchangeId]);
const body = (binding: AssistantDisclosureBinding) => digest(JSON.stringify([binding.question, binding.answer]));

export function captureAssistantSourceReads(value: unknown): readonly AssistantSourceRead[] {
  if (!Array.isArray(value) || value.length > ASSISTANT_DISCLOSURE_LIMITS.reads) throw Error();
  const result: AssistantSourceRead[] = [];
  for (let offset = 0; offset < value.length; offset += 16) {
    const entries = value.slice(offset, offset + 16);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exact(entry, ['name', 'input', 'digest']) ||
          typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) throw Error();
    }
    const captured = captureAgentReadBatch(entries.map((entry, index) => ({ id: String(offset + index), name: entry.name, input: entry.input })));
    captured.forEach((call, index) => {
      if (call.input === undefined) throw Error();
      result.push(Object.freeze({ name: call.name, input: call.input, digest: entries[index].digest }));
    });
  }
  return Object.freeze(result);
}

/** No secret/configuration or incomplete source evidence means no historical disclosure receipt.
 * It never turns a failed read into an authenticated successful one. The caller retains its audit.
 */
export function sealAssistantDisclosure(binding: AssistantDisclosureBinding, reads: readonly AssistantSourceRead[] | undefined): string | null {
  try {
    if (!isSecretStorable() || !binding.answer || reads === undefined) return null;
    const captured = captureAssistantSourceReads(reads);
    const plaintext = JSON.stringify({ v: ASSISTANT_DISCLOSURE_VERSION, body: body(binding), reads: captured });
    if (bytes(plaintext) > ASSISTANT_DISCLOSURE_LIMITS.plainBytes) return null;
    const sealed = encryptSecret(plaintext, aad(binding));
    return bytes(sealed) <= ASSISTANT_DISCLOSURE_LIMITS.tokenBytes ? sealed : null;
  } catch { return null; }
}

/** Missing/legacy, cross-owner, swapped body, corrupt, unknown-version and malformed proof all refuse.
 * The only outward value is captured lookup inputs and encrypted-at-rest result fingerprints.
 * No decryption error or secret material crosses this boundary.
 */
export function openAssistantDisclosure(binding: AssistantDisclosureBinding, token: unknown): readonly AssistantSourceRead[] | null {
  try {
    if (!isSecretStorable() || !binding.answer || typeof token !== 'string' || bytes(token) > ASSISTANT_DISCLOSURE_LIMITS.tokenBytes ||
        !/^[A-Za-z0-9_-]+$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
    const plaintext = decryptSecret(token, aad(binding));
    if (bytes(plaintext) > ASSISTANT_DISCLOSURE_LIMITS.plainBytes) return null;
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proof = value as Record<string, unknown>;
    if (!exact(proof, ['v', 'body', 'reads']) || proof.v !== ASSISTANT_DISCLOSURE_VERSION || proof.body !== body(binding)) return null;
    return captureAssistantSourceReads(proof.reads);
  } catch { return null; }
}
