/** Human Knowledge Base publication source. The connected shared custody command and human POST own
 * top-level completion/retry: calling create again is NOT idempotent. Source wiring is not runtime proof. No provider
 * drafts, generated policies, upload bytes, arbitrary audience grants or copied HR facts. */
import {createHash} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {domainEvent,kbDocument} from '../../db/schema';
import {withAgentActionGuard} from './agent-action-guard';
import {assertKbAuthor,prepareArticleContent,createArticleTx,visibleAudiencesFor} from '../knowledge-base';
import {KNOWLEDGE_ARTICLE_ACTION,KnowledgeArticleHumanContent,KnowledgeArticleConfirmation,KnowledgeArticlePreparedSource,KnowledgeArticleSourceReceipt} from '../../lib/assistant-actions/knowledge-article-contract';
const fail=():never=>{throw Error('Article publication could not be confirmed.');};
export async function assertKnowledgeArticleActorTx(tx:Tx,supplied:SessionContext){
 const current={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 const fresh=await withAgentActionGuard(tx,current,KNOWLEDGE_ARTICLE_ACTION);assertKbAuthor(fresh);return fresh;
}
function normalized(ctx:SessionContext,input:KnowledgeArticleHumanContent){return KnowledgeArticleHumanContent.parse({action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,...prepareArticleContent(ctx,input)});}
function digest(ctx:SessionContext,content:KnowledgeArticleHumanContent){return createHash('sha256').update(JSON.stringify({version:1,tenantId:ctx.tenantId,userId:ctx.userId,content})).digest('hex');}
export async function prepareKnowledgeArticleSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const captured=KnowledgeArticleHumanContent.parse(structuredClone(value)),fresh=await assertKnowledgeArticleActorTx(tx,ctx),content=normalized(fresh,captured);
 return KnowledgeArticlePreparedSource.parse({kind:'prepared_source',content,reviewedDigest:digest(fresh,content),consequence:'publish_to_selected_audience'});
}
/** Native effect and exact created event are returned together. Whole caller transaction MUST roll
 * back on any refusal/completion failure. Stored content must come from trusted encrypted custody. */
export async function confirmKnowledgeArticleSourceTx(tx:Tx,ctx:SessionContext,storedHumanValue:unknown,confirmationValue:unknown){
 const captured=KnowledgeArticleHumanContent.parse(structuredClone(storedHumanValue)),confirmation=KnowledgeArticleConfirmation.parse(structuredClone(confirmationValue));
 const fresh=await assertKnowledgeArticleActorTx(tx,ctx),content=normalized(fresh,captured);if(digest(fresh,content)!==confirmation.reviewedDigest)return fail();
 const effect=await createArticleTx(tx,fresh,content);return reconcileKnowledgeArticleSourceTx(tx,fresh,{articleId:effect.id,createdEventId:effect.eventId});
}
/** Metadata-only canonical reconciliation. Later edits are not asserted to be the originally
 * reviewed text; the native event proves this caller created the current own-authored record. */
export async function reconcileKnowledgeArticleSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const reference=KnowledgeArticleSourceReceipt.pick({articleId:true,createdEventId:true}).strict().parse(value),fresh=await assertKnowledgeArticleActorTx(tx,ctx);
 const [event]=await tx.select({id:domainEvent.id}).from(domainEvent).where(and(eq(domainEvent.id,reference.createdEventId),eq(domainEvent.tenantId,fresh.tenantId),
  eq(domainEvent.aggregateType,'kb-document'),eq(domainEvent.aggregateId,reference.articleId),eq(domainEvent.eventType,'kb.document.created'),eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,fresh.userId!)));
 if(!event)return fail();const [article]=await tx.select({kind:kbDocument.kind,author:kbDocument.createdByUserId,audience:kbDocument.audience,archivedAt:kbDocument.archivedAt}).from(kbDocument)
  .where(and(eq(kbDocument.id,reference.articleId),eq(kbDocument.tenantId,fresh.tenantId),eq(kbDocument.createdByUserId,fresh.userId!)));
 if(!article||article.kind!=='article'||!visibleAudiencesFor(fresh).includes(article.audience as 'all'|'employee'|'manager'|'hr_admin'))return fail();
 return KnowledgeArticleSourceReceipt.parse({action:KNOWLEDGE_ARTICLE_ACTION,contractVersion:1,articleId:reference.articleId,createdEventId:reference.createdEventId,
  currentState:article.archivedAt?'archived':'active',currentAudience:article.audience,proof:'recorded_creation_current_record'});
}
