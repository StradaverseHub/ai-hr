/** Walk only the already permission-filtered native shell. No route, grant or DOM mutation. */
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
const roots=['aside[data-app-sidebar] nav[data-tour="nav"]','[id^="nav-flyout-"] nav','[id^="atelier-flyout-"] nav'];
const controls=roots.map(root=>root+' button[aria-controls][aria-expanded="false"]').join(',');
const staticShellHref=(value:unknown):value is string=>typeof value==='string'&&/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*(?![\s\S])/.test(value);
async function visible(locator:Locator){
 const count=await locator.count();assert(count<=128,'Native shell selector exceeds its bound');
 const result:Locator[]=[];
 for(let i=0;i<count;i++){const item=locator.nth(i);if(await item.isVisible())result.push(item);}
 return result;
}
async function traverseNativeShellDestination(page:Page,href:string,remaining:()=>number,mode:'click'|'hidden'){
 assert(staticShellHref(href),'Only reviewed static shell destinations are supported');
 const sidebar=page.locator('aside[data-app-sidebar]');
 await sidebar.waitFor({state:'visible',timeout:remaining()});
 const value=JSON.stringify(href);
 const anchors=roots.map(root=>root+' a[href='+value+']');
 // Only absence uses the identity of a mounted row. Clicks still require the actual href.
 const target=page.locator((mode==='hidden'?[...anchors,...roots.map(root=>root+' [data-shell-destination='+value+']')]:anchors).join(','));
 const disabled=mode==='hidden'?page.locator(roots.map(root=>root+' span[aria-disabled]').join(',')):undefined;
 const assertHidden=async(message:string)=>{
  if(disabled){
   const count=await disabled.count();
   assert(count<=128,'Native shell disabled destination inventory exceeds its bound');
   for(let i=0;i<count;i++){
    const span=disabled.nth(i);
    assert(await span.getAttribute('aria-disabled',{timeout:remaining()})==='true'&&
     staticShellHref(await span.getAttribute('data-shell-destination',{timeout:remaining()})),
    'Native shell disabled destination has no valid identity');
   }
  }
  assert(await target.count()===0,message);
 };
 const workspaces=sidebar.locator('[role="group"] > button[aria-pressed]');
 const workspaceCount=await workspaces.count();assert(workspaceCount<=2,'Unexpected native workspace inventory');
 const alternatives:number[]=[];
 for(let i=0;i<workspaceCount;i++){
  assert(await workspaces.nth(i).isVisible(),'Native workspace is not visible');
  const pressed=await workspaces.nth(i).getAttribute('aria-pressed');
  assert(pressed==='true'||pressed==='false','Native workspace state is missing');
  if(pressed==='false')alternatives.push(i);
 }
 assert(workspaceCount===0||alternatives.length===workspaceCount-1,'Native workspace selection is ambiguous');
 let interactions=0;
 for(const workspace of [null,...alternatives]){
  if(workspace!==null){
   const button=workspaces.nth(workspace);assert(await button.isEnabled(),'Native workspace is unavailable');
   await button.click({timeout:remaining()});
   await workspaces.nth(workspace).and(sidebar.locator('[aria-pressed="true"]')).waitFor({state:'visible',timeout:remaining()});
  }
  const opened=new Set<string>();
  for(;;){
   remaining();
   // Count mounted destinations, including disabled rows in collapsed or alternate workspaces.
   if(mode==='hidden')await assertHidden('Denied destination is still rendered in the native shell');
   const links=await visible(target);assert(links.length<=1,'Native shell destination is ambiguous');
   if(mode==='hidden')assert(links.length===0,'Denied destination became visible in the native shell');
   if(mode==='click'&&links.length){
    assert(await links[0].getAttribute('href')===href&&await links[0].isEnabled(),'Native shell destination changed or is unavailable');
    await links[0].click({timeout:remaining()});return;
   }
   const available=await visible(page.locator(controls));let next:Locator|undefined,id='';
   for(const button of available){
    const controlled=await button.getAttribute('aria-controls');
    assert(controlled&&controlled.length<=256,'Native navigation disclosure has no bounded identity');
    if(!opened.has(controlled)){next=button;id=controlled;break;}
   }
   if(!next)break;
   assert(++interactions<=128,'Native navigation disclosure traversal exceeds its bound');opened.add(id);
   assert(await next.isEnabled(),'Native navigation disclosure is unavailable');
   await next.click({timeout:remaining()});
   await page.locator(roots.map(root=>root+' button[aria-controls='+JSON.stringify(id)+'][aria-expanded="true"]').join(','))
    .waitFor({state:'visible',timeout:remaining()});
  }
  if(mode==='hidden')await assertHidden('Denied destination appeared before native workspace observation completed');
 }
 if(mode==='hidden')await assertHidden('Denied destination appeared before native shell observation completed');
 if(mode==='click')throw Error('Reviewed destination is absent from the actual native shell');
}
export async function clickNativeShellDestination(page:Page,href:string,remaining:()=>number){
 await traverseNativeShellDestination(page,href,remaining,'click');
}
/** Absence is observed through the real disclosures, then the collector separately
 * exercises the native direct-route refusal. This is not a permission resolver. */
export async function assertNativeShellDestinationHidden(page:Page,href:string,remaining:()=>number){
 await traverseNativeShellDestination(page,href,remaining,'hidden');
}
