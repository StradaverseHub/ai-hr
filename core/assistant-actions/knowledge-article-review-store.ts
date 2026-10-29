/** WP9: login-bound Knowledge publication through the generic OWN compatibility protocol.
 * Existing SQL rows, binding order, sealed bodies and native creation verification remain unchanged. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createGenericOwnCompatibilityStore} from './generic-own-review-store';
import {OwnLeaveSealedReview} from './own-leave-content';
import {KNOWLEDGE_ARTICLE_ACTION as action,KnowledgeArticleHumanContent} from '../../lib/assistant-actions/knowledge-article-contract';
import {KnowledgeArticleReviewConfirmation,KnowledgeArticleReviewRetirement,KnowledgeArticlePreparedReview,KnowledgeArticleCompletedReview,KnowledgeArticleRetiredReview,KnowledgeArticleReviewIndex} from '../../lib/assistant-actions/knowledge-article-review-contract';
import {assertKnowledgeArticleActorTx,prepareKnowledgeArticleSourceTx,confirmKnowledgeArticleSourceTx,reconcileKnowledgeArticleSourceTx} from './knowledge-article-source';
export class KnowledgeArticleReviewUnavailable extends Error{constructor(){super('That article review has wandered off for a moment. Please reopen it and try again.');this.name='KnowledgeArticleReviewUnavailable';}}
const fail=():never=>{throw new KnowledgeArticleReviewUnavailable();};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const Binding=z.object({tenantId:z.guid(),userId:z.guid(),personId:z.guid().nullable(),employmentId:z.null(),companyId:z.null()}).strict();
const Metadata=z.object({actionId:z.guid(),action:z.literal(action),contractVersion:z.literal(1),binding:Binding,intentDigest:digest.nullable(),reviewedDigest:digest.nullable(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict();type Meta=z.infer<typeof Metadata>;
const Stored=z.object({metadata:Metadata,sealed:OwnLeaveSealedReview.nullable(),articleId:z.guid().nullable(),eventId:z.guid().nullable()}).strict().refine(value=>
 (value.metadata.state==='awaiting_confirmation')===(value.sealed!==null&&value.metadata.intentDigest!==null&&value.metadata.reviewedDigest!==null)
 &&(value.metadata.state==='completed')===(value.articleId!==null&&value.eventId!==null)
 &&((value.articleId===null)===(value.eventId===null))
 &&(value.metadata.state==='awaiting_confirmation'||(value.sealed===null&&value.metadata.intentDigest===null&&value.metadata.reviewedDigest===null)));
type Stored=z.infer<typeof Stored>;
export const knowledgeArticleReviews=createGenericOwnCompatibilityStore<
 z.infer<typeof KnowledgeArticleHumanContent>,z.infer<typeof Binding>,Stored,null,
 Awaited<ReturnType<typeof prepareKnowledgeArticleSourceTx>>,Awaited<ReturnType<typeof confirmKnowledgeArticleSourceTx>>,
 z.infer<typeof KnowledgeArticlePreparedReview>,z.infer<typeof KnowledgeArticleCompletedReview>,z.infer<typeof KnowledgeArticleRetiredReview>,z.infer<typeof KnowledgeArticleReviewIndex>
>({
 action,tier:'confirm',human:KnowledgeArticleHumanContent,metadata:Metadata,stored:Stored,
 confirmation:KnowledgeArticleReviewConfirmation,retirement:KnowledgeArticleReviewRetirement,retired:KnowledgeArticleRetiredReview,index:KnowledgeArticleReviewIndex,indexKind:'knowledge_article_review_index',
 async withInterval(tx,ctx,_nomination,work){return work(await assertKnowledgeArticleActorTx(tx,ctx),null);},
 binding:(ctx)=>Binding.parse({tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId??null,employmentId:null,companyId:null}),
 assertSubjectBinding:()=>{},assertHumanBinding:()=>{},
 prepareNative:(tx,ctx,human)=>prepareKnowledgeArticleSourceTx(tx,ctx,human),
 confirmNative:(tx,ctx,body)=>confirmKnowledgeArticleSourceTx(tx,ctx,body.content,{action,contractVersion:1,reviewedDigest:body.nativeReviewedDigest}),
 pending:(row,body)=>KnowledgeArticlePreparedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,reviewedDigest:row.metadata.reviewedDigest,createdAt:row.metadata.createdAt,expiresAt:row.metadata.expiresAt,content:body.content,consequence:'publish_to_selected_audience'}),
 async completed(tx,ctx,row){if(!row.articleId||!row.eventId)return fail();const receipt=await reconcileKnowledgeArticleSourceTx(tx,ctx,{articleId:row.articleId,createdEventId:row.eventId});return KnowledgeArticleCompletedReview.parse({action,contractVersion:1,actionId:row.metadata.actionId,state:'completed',receipt});},
 event:row=>row.eventId,nativeEvent:native=>native.createdEventId,
 assertCompletion:(row,native)=>{if(row.articleId!==native.articleId||row.eventId!==native.createdEventId)return fail();},targets:()=>[],
 async prepareRow(tx,m,sealed){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_knowledge_article_review_prepare(${m.actionId}::uuid,${m.binding.personId}::uuid,${m.intentDigest},${m.reviewedDigest},${sealed.kid},${sealed.wrappedDek},${sealed.ciphertext}) as review`);return row?.review;},
 async readRow(tx,id){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_knowledge_article_review_read(${id}::uuid) as review`);return row?.review;},
 async completeRow(tx,id,expected,native){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_knowledge_article_review_complete(${id}::uuid,${expected},${native.articleId}::uuid,${native.createdEventId}::uuid) as review`);return row?.review;},
 async discardRow(tx,id){const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_knowledge_article_review_discard(${id}::uuid) as receipt`);return row?.receipt;},
 async indexRows(tx){return Array.from(await tx.execute(sql`select action,1 as "contractVersion",action_id as "actionId",state,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt" from app.assistant_knowledge_article_reviews_index()`));},unavailable:fail,
});
export const prepareKnowledgeArticleReview=knowledgeArticleReviews.prepare;
export const confirmKnowledgeArticleReview=knowledgeArticleReviews.confirm;
export const reopenKnowledgeArticleReview=knowledgeArticleReviews.reopen;
export const discardKnowledgeArticleReview=knowledgeArticleReviews.discard;
export const listKnowledgeArticleReviews=knowledgeArticleReviews.list;
export const readCompletedKnowledgeArticleOutcomeTx=knowledgeArticleReviews.readCompletedOutcomeTx;
