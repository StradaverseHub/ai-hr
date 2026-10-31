/** Server-only source fingerprints for historical answer reauthorization. No source rows are stored.
 * A receipt authenticates the trusted command's source binding, not model truth or effect authority.
 */
import { createHash } from 'node:crypto';
import {types as nodeTypes} from 'node:util';
import { captureAssistantAnswerPlan, type AssistantAnswerPlan } from './assistant-answer-plan';
import { captureAgentReadBatch, serializeAgentReadResult } from './agent-read-batch';
import { decryptSecret, encryptSecret, isSecretStorable } from './crypto';

export const ASSISTANT_DISCLOSURE_VERSION = 1;
export const ASSISTANT_DISCLOSURE_LIMITS = Object.freeze({ reads: 128, tokenBytes: 786_432, plainBytes: 524_288 });
export type AssistantDisclosureBinding = Readonly<{ tenantId: string; userId: string; exchangeId: string; question: string; answer: string }>;
export type AssistantThreadMetadata=Readonly<{threadId:string;scopeDigest:string}>;
/** Authenticated local grouping/scope only; no continuation capability or human text is stored here. */
export function captureAssistantThreadMetadata(value:unknown):AssistantThreadMetadata{
 if(!value||typeof value!=='object'||Array.isArray(value)||nodeTypes.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Assistant thread unavailable.');
 const fields=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(fields);
 if(keys.length!==2||!keys.every(key=>typeof key==='string'&&['threadId','scopeDigest'].includes(key)&&fields[key]?.enumerable&&'value'in fields[key]))throw Error('Assistant thread unavailable.');
 const threadId=fields.threadId.value,scopeDigest=fields.scopeDigest.value;
 if(typeof threadId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)||typeof scopeDigest!=='string'||!/^[a-f0-9]{64}$/.test(scopeDigest))throw Error('Assistant thread unavailable.');
 return Object.freeze({threadId,scopeDigest});
}
export type AssistantSourceRead = Readonly<{ name: string; input: unknown; digest: string;moduleJobId?:string }>;
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
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exact(entry, ['name', 'input', 'digest',...(entry.moduleJobId===undefined?[]:['moduleJobId'])]) ||
          (entry.moduleJobId!==undefined&&(entry.name!=='my_module_work'||typeof entry.moduleJobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.moduleJobId))) ||
          typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest)) throw Error();
    }
    const captured = captureAgentReadBatch(entries.map((entry, index) => ({ id: String(offset + index), name: entry.name, input: entry.input })));
    captured.forEach((call, index) => {
      if (call.input === undefined) throw Error();
      result.push(Object.freeze({ name: call.name, input: call.input, digest: entries[index].digest,...(entries[index].moduleJobId===undefined?{}:{moduleJobId:entries[index].moduleJobId}) }));
    });
  }
  return Object.freeze(result);
}

/** No secret/configuration or incomplete source evidence means no historical disclosure receipt.
 * It never turns a failed read into an authenticated successful one. The caller retains its audit.
 */
export function sealAssistantDisclosure(binding: AssistantDisclosureBinding, reads: readonly AssistantSourceRead[] | undefined, answerPlan?: AssistantAnswerPlan, thread?:AssistantThreadMetadata): string | null {
  try {
    if (!isSecretStorable() || !binding.answer || reads === undefined) return null;
    const captured = captureAssistantSourceReads(reads);
    const plaintext = JSON.stringify(thread===undefined?(answerPlan === undefined
      ? { v: ASSISTANT_DISCLOSURE_VERSION, body: body(binding), reads: captured }
      : { v: 2, body: body(binding), reads: captured, plan: captureAssistantAnswerPlan(answerPlan) }):
      {v:3,body:body(binding),reads:captured,plan:answerPlan===undefined?null:captureAssistantAnswerPlan(answerPlan),thread:captureAssistantThreadMetadata(thread)});
    if (bytes(plaintext) > ASSISTANT_DISCLOSURE_LIMITS.plainBytes) return null;
    const sealed = encryptSecret(plaintext, aad(binding));
    return bytes(sealed) <= ASSISTANT_DISCLOSURE_LIMITS.tokenBytes ? sealed : null;
  } catch { return null; }
}

/** Missing/legacy, cross-owner, swapped body, corrupt, unknown-version and malformed proof all refuse.
 * The only outward value is captured lookup inputs and encrypted-at-rest result fingerprints.
 * No decryption error or secret material crosses this boundary.
 */
export type AssistantAnswerDisclosure = Readonly<{ reads: readonly AssistantSourceRead[]; plan: AssistantAnswerPlan | null;thread?:AssistantThreadMetadata }>;

/** Legacy receipts retain their old card-only meaning. A v2 plan is authenticated with the exact
 * question, raw terminal body, principal and source lookup fingerprints, then adjudicated on replay. */
export function openAssistantAnswerDisclosure(binding: AssistantDisclosureBinding, token: unknown): AssistantAnswerDisclosure | null {
  try {
    if (!isSecretStorable() || !binding.answer || typeof token !== 'string' || bytes(token) > ASSISTANT_DISCLOSURE_LIMITS.tokenBytes ||
        !/^[A-Za-z0-9_-]+$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
    const plaintext = decryptSecret(token, aad(binding));
    if (bytes(plaintext) > ASSISTANT_DISCLOSURE_LIMITS.plainBytes) return null;
    const value: unknown = JSON.parse(plaintext);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const proof = value as Record<string, unknown>;
    if (proof.body !== body(binding)) return null;
    const reads = captureAssistantSourceReads(proof.reads);
    if (proof.v === ASSISTANT_DISCLOSURE_VERSION && exact(proof, ['v', 'body', 'reads']))
      return Object.freeze({ reads, plan: null });
    if (proof.v === 2 && exact(proof, ['v', 'body', 'reads', 'plan']))
      return Object.freeze({ reads, plan: captureAssistantAnswerPlan(proof.plan) });
    if(proof.v===3&&exact(proof,['v','body','reads','plan','thread']))
      return Object.freeze({reads,plan:proof.plan===null?null:captureAssistantAnswerPlan(proof.plan),thread:captureAssistantThreadMetadata(proof.thread)});
    return null;
  } catch { return null; }
}

/** Existing source-only callers do not acquire conversational semantics from a legacy receipt. */
export function openAssistantDisclosure(binding: AssistantDisclosureBinding, token: unknown): readonly AssistantSourceRead[] | null {
  return openAssistantAnswerDisclosure(binding, token)?.reads ?? null;
}
