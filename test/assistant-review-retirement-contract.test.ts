/** Authored, UNRUN. Lost-response privacy cleanup is not permission to confirm an effect. */
import {describe,expect,it} from 'vitest';
import {KnowledgeArticleReviewConfirmation,KnowledgeArticleReviewRetirement,KnowledgeArticleReviewIndex} from '../lib/assistant-actions/knowledge-article-review-contract';
import {LifecycleAckReviewConfirmation,LifecycleAckReviewRetirement,LifecycleAckReviewIndex} from '../lib/assistant-actions/lifecycle-ack-review-contract';

const actionId='c1adce2a-580c-4f85-8383-66014593b8e9';
const cases=[
  {action:'knowledge_base.article.create',kind:'knowledge_article_review_index',index:KnowledgeArticleReviewIndex,retire:KnowledgeArticleReviewRetirement,confirm:KnowledgeArticleReviewConfirmation},
  {action:'lifecycle.acknowledgement.submit',kind:'lifecycle_ack_review_index',index:LifecycleAckReviewIndex,retire:LifecycleAckReviewRetirement,confirm:LifecycleAckReviewConfirmation},
] as const;

describe.each(cases)('$action lost-response cleanup contract',protocol=>{
  it('can construct retirement from login metadata alone, while confirmation still refuses it',()=>{
    const index=protocol.index.parse({kind:protocol.kind,reviews:[{action:protocol.action,contractVersion:1,actionId,state:'awaiting_confirmation',createdAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-01T00:10:00.000Z'}]});
    const metadata=index.reviews[0];
    const request={action:metadata.action,contractVersion:metadata.contractVersion,actionId:metadata.actionId};
    expect(protocol.retire.parse(request)).toEqual(request);
    expect(protocol.confirm.safeParse(request).success).toBe(false);
    expect(Object.keys(metadata).sort()).toEqual(['action','actionId','contractVersion','createdAt','expiresAt','state']);
  });

  it('keeps effect confirmation and privacy retirement as distinct closed requests',()=>{
    const request={action:protocol.action,contractVersion:1,actionId};
    expect(protocol.confirm.safeParse({...request,reviewedDigest:'a'.repeat(64)}).success).toBe(true);
    for(const extra of [{reviewedDigest:'a'.repeat(64)},{body:'private content'},{userId:actionId},{tenantId:actionId},{caseId:actionId},{articleId:actionId},{state:'completed'}]){
      expect(protocol.retire.safeParse({...request,...extra}).success).toBe(false);
    }
    expect(protocol.retire.safeParse({...request,contractVersion:2}).success).toBe(false);
    expect(protocol.retire.safeParse({...request,actionId:'not-an-id'}).success).toBe(false);
    const other=cases.find(candidate=>candidate.action!==protocol.action)!;
    expect(protocol.retire.safeParse({...request,action:other.action}).success).toBe(false);
  });
});
