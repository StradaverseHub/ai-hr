/** FAKE-PAGE PROTOCOL ONLY. No browser, DB, server action, authentication or provider is exercised. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_CONTROLS_CHECKS,AI_CONTROLS_PHASES,assertAiControlsFacts,runAssistantAiControlsEnglishExperience} from './assistant-ai-controls-experience.mjs';
const userId='00000000-0000-4000-8000-000000000001',fixture={state:'native_prerequisites_prepared_not_experienced',actors:{operator:{userId}}};
const baseline=()=>({currentActorUserId:userId,spend:null,defaultAllowance:null,spendEventCount:0,allowanceEventCount:0,otherControlEventCount:0,modelRunCount:0,providerConfigCount:0,providerCandidateCount:0,reviewedCarrierRecordCount:0});
const nanos=value=>{const[whole,decimal='']=value.split('.');return(BigInt(whole)*BigInt(1000000000)+BigInt(decimal.padEnd(9,'0'))).toString();};
const usd=value=>{const text=value.padStart(10,'0');return text.slice(0,-9)+(text.slice(-9).replace(/0+$/,'')?'.'+text.slice(-9).replace(/0+$/,''):'');};
class Element{
 constructor(page,kind,name){this.page=page;this.kind=kind;this.name=name;}
 locator(selector){if(this.kind==='spend'&&selector.startsWith('xpath='))return this;if((this.kind==='spend'||this.kind==='allowance')&&selector==='form')return new Element(this.page,this.kind+'-form');if(this.kind==='allowance-form'){const name=/name="([^"]+)"/.exec(selector)?.[1];if(name)return new Element(this.page,'input',name);}throw Error('Unsupported protocol selector');}
 getByRole(role,options){assert.equal(role,'button');assert.equal(options.name,'Save');assert.equal(options.exact,true);return new Element(this.page,'button',this.kind);}
 getByLabel(label,options){assert.equal(options.exact,true);return new Element(this.page,'input',label==='Tenant monthly allocation (USD)'?'monthlyUsd':label==='Per-task lifetime allocation (USD)'?'rootUsd':'unsupported');}
 getByText(text,options){assert.equal(options.exact,true);assert(text.includes('do not verify live access'));return new Element(this.page,'text');}
 async waitFor(){} async count(){return 1;}
 async fill(value){this.page.values[this.name]=value;}
 async inputValue(){return this.page.values[this.name];}
 async getAttribute(name){return name==='step'?'1':name==='max'?'1000000':null;}
 async evaluate(fn){return fn({validity:{valid:Number.isInteger(Number(this.page.values[this.name]))}});}
 async selectOption(value){this.page.values[this.name]=value;}
 async click(){await this.page.submit(this.name);}
 async innerText(){return'Protocol fixture only';}
}
class FakePage{
 constructor({ignoreSpend=false,loseZero=false,extraProvider=false}={}){this.options={ignoreSpend,loseZero,extraProvider};this.state=baseline();this.values={};this.current='http://127.0.0.1:3210/assistant';this.listeners=new Set();this.phases=[];this.trace=[];this.restore();}
 restore(){const a=this.state.defaultAllowance;this.values={monthlyUsd:this.state.spend?usd(this.state.spend.monthlyNanos):'0',rootUsd:this.state.spend?usd(this.state.spend.rootNanos):'0',dailyRequests:a?.dailyRequests==null?'':String(a.dailyRequests),monthlyTokens:a?.monthlyTokens??'',maxConcurrent:a?.maxConcurrent==null?'':String(a.maxConcurrent),enabled:String(a?.enabled!==false)};}
 url(){return this.current;} on(name,fn){assert.equal(name,'request');this.listeners.add(fn);} off(name,fn){assert.equal(name,'request');this.listeners.delete(fn);}
 async goto(url){this.current=url;this.restore();} async reload(){this.restore();if(this.options.extraProvider)this.state.providerCandidateCount=1;}
 locator(selector){if(selector==='body')return new Element(this,'body');assert.equal(selector,'section[aria-labelledby="ai-user-default"]');return new Element(this,'allowance');}
 getByRole(role,options){if(role==='alert')return new Element(this,'alert');assert.equal(role,'heading');assert.deepEqual(options,{name:'AI inference allocation (USD)',exact:true});return new Element(this,'spend');}
 waitForResponse(predicate){return new Promise((resolve,reject)=>{this.pending={predicate,resolve,reject};});}
 async waitForURL(predicate){assert(predicate(new URL(this.current)),'Expected protocol redirect missing');}
 async submit(form){
  this.trace.push({form,values:{...this.values}});
  if(form==='allowance-form'&&this.values.maxConcurrent!==''&&!Number.isInteger(Number(this.values.maxConcurrent)))return;
  const request={method:()=> 'POST',url:()=> 'http://127.0.0.1:3210/control-tower/agents'};for(const listener of this.listeners)listener(request);
  let mode='toast';if(form==='spend-form'){
   if(!/^\d+(?:\.\d{1,9})?$/.test(this.values.monthlyUsd))mode='error';else if(!this.options.ignoreSpend){this.state.spend={monthlyNanos:nanos(this.values.monthlyUsd),rootNanos:nanos(this.values.rootUsd)};this.state.spendEventCount++;}
  }else{assert.equal(form,'allowance-form');this.state.defaultAllowance={enabled:this.values.enabled==='true',dailyRequests:this.values.dailyRequests===''?null:Number(this.values.dailyRequests),monthlyTokens:this.values.monthlyTokens===''?null:this.values.monthlyTokens,maxConcurrent:this.values.maxConcurrent===''?null:Number(this.values.maxConcurrent)};if(this.options.loseZero&&this.state.defaultAllowance.maxConcurrent===0)this.state.defaultAllowance.maxConcurrent=null;this.state.allowanceEventCount++;}
  this.current='http://127.0.0.1:3210/control-tower/agents?'+mode+'=protocol-only';const response={url:request.url,request:()=>request,ok:()=>true,status:()=>200,finished:async()=>{}};const pending=this.pending;this.pending=null;if(!pending)throw Error('Missing protocol response listener');if(pending.predicate(response))pending.resolve(response);else pending.reject(Error('Unexpected protocol response'));
 }
 verify=async({phase})=>{this.phases.push(phase);return structuredClone(this.state);};
}
test('closed private facts refuse wrong actors, unknown fields, provider activity and zero/null confusion',()=>{
 assert.deepEqual(assertAiControlsFacts(baseline(),userId),baseline());
 for(const patch of [{currentActorUserId:'other'},{secret:'not-allowed'},{providerCandidateCount:1},{reviewedCarrierRecordCount:1},{modelRunCount:1},{spendEventCount:-1},{spend:{monthlyNanos:'1e9',rootNanos:'0'}},{defaultAllowance:{enabled:true,dailyRequests:null,monthlyTokens:null,maxConcurrent:'0'}}])assert.throws(()=>assertAiControlsFacts({...baseline(),...patch},userId));
 const row={...baseline(),defaultAllowance:{enabled:true,dailyRequests:null,monthlyTokens:null,maxConcurrent:0}};assert.equal(assertAiControlsFacts(row,userId).defaultAllowance.maxConcurrent,0);
});
test('fake page exercises exact form/phase protocol and fixed checklist without making browser claims',async()=>{
 const page=new FakePage(),result=await runAssistantAiControlsEnglishExperience({page,fixture,verifyNative:page.verify});assert.equal(result.journey,'english_ai_controls');assert.deepEqual(result.checks,AI_CONTROLS_CHECKS.map(id=>({id,passed:true})));assert.deepEqual(page.phases,AI_CONTROLS_PHASES);assert.equal(page.listeners.size,0);assert.equal(page.trace.filter(step=>step.form==='spend-form').length,2);assert.equal(page.trace.filter(step=>step.form==='allowance-form').length,4);assert.equal(result.capability,'UNVERIFIED_NO_PROVIDER_JOURNEY');assert(result.notCovered.includes('actual provider admission under zero concurrency'));
});
test('fake server success cannot replace native persisted values, exact zero, or absence of provider writes',async()=>{
 for(const options of [{ignoreSpend:true},{loseZero:true},{extraProvider:true}]){const page=new FakePage(options);await assert.rejects(runAssistantAiControlsEnglishExperience({page,fixture,verifyNative:page.verify}),{message:'assistant_ai_controls_experience:unavailable'});assert.equal(page.listeners.size,0);}
});
test('unexpected native counter/actor snapshots refuse rather than returning a partial PASS checklist',async()=>{
 for(const fault of ['actor','unexpected-control-event']){const page=new FakePage();await assert.rejects(runAssistantAiControlsEnglishExperience({page,fixture,verifyNative:async input=>{const facts=await page.verify(input);if(fault==='actor')facts.currentActorUserId='different';else if(input.phase==='spend_saved')facts.otherControlEventCount++;return facts;}}),{message:'assistant_ai_controls_experience:unavailable'});assert.equal(page.listeners.size,0);}
});
