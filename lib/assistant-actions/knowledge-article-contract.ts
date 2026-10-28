/** Explicit human-authored publication. No model-generated HR policy or posted execution owner. */
import {z} from 'zod';
export const KNOWLEDGE_ARTICLE_ACTION='knowledge_base.article.create' as const;
export const KnowledgeArticleHumanContent=z.object({action:z.literal(KNOWLEDGE_ARTICLE_ACTION),contractVersion:z.literal(1),
 title:z.string().min(1).max(200),body:z.string().min(1).max(24000),category:z.string().max(200),audience:z.enum(['all','employee','manager','hr_admin'])}).strict()
 .refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=24000,'Article review is too large.');
export type KnowledgeArticleHumanContent=z.infer<typeof KnowledgeArticleHumanContent>;
export const KnowledgeArticleConfirmation=z.object({action:z.literal(KNOWLEDGE_ARTICLE_ACTION),contractVersion:z.literal(1),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const KnowledgeArticlePreparedSource=z.object({kind:z.literal('prepared_source'),content:KnowledgeArticleHumanContent,
 reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),consequence:z.literal('publish_to_selected_audience')}).strict();
export const KnowledgeArticleSourceReceipt=z.object({action:z.literal(KNOWLEDGE_ARTICLE_ACTION),contractVersion:z.literal(1),articleId:z.guid(),createdEventId:z.guid(),
 currentState:z.enum(['active','archived']),currentAudience:z.enum(['all','employee','manager','hr_admin']),proof:z.literal('recorded_creation_current_record')}).strict();
