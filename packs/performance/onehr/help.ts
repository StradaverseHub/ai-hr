import type {SessionContext} from '../../../db/client';
import {searchKnowledgeArticles} from '../../../core/knowledge-base';
import {assessmentHelpQuery} from '../../../lib/knowledge-search';
/** Curated articles are displayed as quoted guidance, never interpreted as commands or sent to a model. */
export async function assessmentHelp(ctx:SessionContext,text:string){
 const query=assessmentHelpQuery(text);if(!query)return null;
 const articles=await searchKnowledgeArticles(ctx,query,'performance-faq');
 return articles.length?'From the Knowledge Base:\n\n'+articles.map(a=>`${a.title}\n${a.body}`).join('\n\n'):'No Performance guidance is available in your Knowledge Base yet. Use the review controls or ask HR for guidance.';
}
