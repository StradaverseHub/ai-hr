import {describe,it,expect,vi} from 'vitest';
import {generateDraft,converse,validateConfig,type ResolvedAiConfig} from '../lib/ai';
import {governed,createUngovernedProbe,type UngovernedProbe} from '../lib/ai/governance';
import {openaiAdapter} from '../lib/ai/providers/openai';
const cfg:ResolvedAiConfig={provider:'openai',model:'fixture',apiKey:'fixture'};
describe('R9 gateway fail-closed',()=>{
 it('refuses hand-built configs before generation or conversation transport',async()=>{
  const draft=vi.spyOn(openaiAdapter,'generate'),chat=vi.spyOn(openaiAdapter,'converse');
  try{
   await expect(generateDraft(cfg,{system:'fixture',prompt:'fixture'})).rejects.toThrow('governance is required');
   await expect(converse(cfg,{system:['fixture'],turns:[{role:'user',content:'fixture'}],tools:[]})).rejects.toThrow('governance is required');
   expect(draft).not.toHaveBeenCalled();expect(chat).not.toHaveBeenCalled();
  }finally{draft.mockRestore();chat.mockRestore();}
 });
 it('refuses a forged probe brand and never calls the supplied transport',()=>{
  const transport=vi.fn();expect(()=>governed({...cfg} as UngovernedProbe,{operation:'probe',reservedTokens:0},transport)).toThrow('governance is required');
  expect(transport).not.toHaveBeenCalled();
 });
 it('allows only the connection check through an explicit issued probe and records failed results',async()=>{
  const log:string[]=[];
  const probe=createUngovernedProbe(cfg,async(request,call)=>{log.push(request.operation);const result=await call(()=>{});log.push('settled');return result;});
  const validate=vi.spyOn(openaiAdapter,'validate').mockResolvedValue({ok:false,error:'generic'});
  try{
   await expect(validateConfig(probe)).resolves.toEqual({ok:false,error:'generic'});
   expect(log).toEqual(['probe','settled']);
   await expect(generateDraft(probe,{system:'fixture',prompt:'fixture'})).rejects.toThrow('cannot execute');
   expect(validate).toHaveBeenCalledTimes(1);
  }finally{validate.mockRestore();}
 });
});
