/** Closed human publication custody protocol. No article IDs, actor, service, upload or model body in confirmation. */
import {z} from 'zod';
import {KNOWLEDGE_ARTICLE_ACTION,KnowledgeArticleHumanContent,KnowledgeArticleSourceReceipt} from './knowledge-article-contract';
const base={action:z.literal(KNOWLEDGE_ARTICLE_ACTION),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const KnowledgeArticleReviewPrepare=KnowledgeArticleHumanContent;
export const KnowledgeArticleReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:digest}).strict();
export const KnowledgeArticlePreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:KnowledgeArticleHumanContent,consequence:z.literal('publish_to_selected_audience')}).strict();
export const KnowledgeArticleCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:KnowledgeArticleSourceReceipt}).strict();
export const KnowledgeArticleRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
/** Login metadata deliberately omits article IDs, audience, title, actor person and human body. */
export const KnowledgeArticleReviewIndex=z.object({kind:z.literal('knowledge_article_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
