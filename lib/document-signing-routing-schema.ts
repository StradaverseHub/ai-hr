/**
 * Storage shape of a template version's signing and review routing (lib/document-signing-routing.ts), for template
 * schemas that persist it. Kept apart from core files so a module's template schema can import it without a cycle.
 */
import {z} from 'zod';
import {DOCUMENT_ROUTING_ACTIONS,MAX_DOCUMENT_ROUTING_ORDER,MAX_DOCUMENT_ROUTING_PEOPLE,MAX_DOCUMENT_ROUTING_STEPS} from './document-signing-routing';

function routingSchema(routingId:z.ZodType<string>){return z.array(z.object({
  id: z.string().min(1).max(120), order: z.number().int().min(1).max(MAX_DOCUMENT_ROUTING_ORDER), action: z.enum(DOCUMENT_ROUTING_ACTIONS), owner: z.boolean(), required:z.boolean().optional(),
  pick: z.enum(['any', 'roundRobin']).optional(),
  who: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('routing'), routingId}).strict(),
    z.object({kind: z.literal('group'), groupId: z.string().min(1).max(200)}).strict(),
    z.object({kind: z.literal('people'), userIds: z.array(z.uuid()).min(1).max(MAX_DOCUMENT_ROUTING_PEOPLE)}).strict(),
    z.object({kind: z.literal('employee')}).strict(),
    z.object({kind: z.literal('directSuperior')}).strict(),
  ]),
}).strict()).max(MAX_DOCUMENT_ROUTING_STEPS);}
/** Shared routing identities keep their original UUID contract. */
export const documentRoutingSchema=routingSchema(z.uuid());
/** Native On/Off Boarding owns bounded string identities, including retained pre-UUID definitions. */
export const nativeDocumentRoutingSchema=routingSchema(z.string().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/u));
