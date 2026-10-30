/** Explicit test-only admission for fictional payloads and injected/mock provider transports.
 * This grants no production privacy provenance. Gateway integration fixtures must use the gateway's
 * own scope instead, so this helper is deliberately applied only at standalone unit factory seams.
 */
import {withProviderEgressDispatch} from '../../lib/ai/provider-egress';
import {draftInputDigest} from '../../lib/ai/draft-input';
import {conversationInputDigest} from '../../lib/ai/conversation-input';
import {createOpenRouterAdapter} from '../../lib/ai/providers/openrouter';
import {createOpenRouterTransport,OpenRouterTransportConfiguration} from '../../lib/ai/providers/openrouter-transport';
import {readOpenRouterOptions} from '../../lib/ai/providers/openrouter-configuration';
import type {ConverseArgs,ResolvedAiConfig} from '../../lib/ai/types';

export function fixtureOpenRouterAdapter(fetcher:typeof fetch){
 const adapter=createOpenRouterAdapter(fetcher);
 return {...adapter,
  generate:(cfg:ResolvedAiConfig,args:Parameters<typeof adapter.generate>[1])=>withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(args)},()=>adapter.generate(cfg,args)),
  converse:(cfg:ResolvedAiConfig,args:ConverseArgs)=>{
   const {onObservation:_,...input}=args;
   return withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(input)},()=>adapter.converse!(cfg,args));
  },
  validate:(cfg:ResolvedAiConfig)=>withProviderEgressDispatch(cfg,{operation:'probe'},()=>adapter.validate(cfg)),
 };
}
export function fixtureOpenRouterTransport(fetcher:typeof fetch,operation:'draft'|'conversation'='conversation'){
 const transport=createOpenRouterTransport(fetcher);
 return (...parameters:Parameters<typeof transport>)=>{
  const [configuration,args]=parameters;
  let cfg:ResolvedAiConfig,inputDigest:string;
  try{
   const route=OpenRouterTransportConfiguration.parse(configuration);
   cfg={provider:'openrouter',model:route.model,apiKey:route.apiKey,providerOptions:readOpenRouterOptions({version:1,routing:route.routing})};
   if(operation==='draft'){
    if(args.system.length!==1||args.turns.length!==1||args.turns[0].role!=='user'||args.tools.length!==0)throw Error('A draft fixture must carry exactly one user question.');
    inputDigest=draftInputDigest({system:args.system[0],prompt:args.turns[0].content,maxTokens:args.maxTokens});
   }else inputDigest=conversationInputDigest(args);
  }catch{
   // Invalid configuration/request cases still reach their original owner and diagnostic phase.
   // They receive no permit and cannot send if the malformed request were accidentally accepted.
   return transport(...parameters);
  }
  return withProviderEgressDispatch(cfg,{operation,inputDigest},()=>transport(...parameters));
 };
}
