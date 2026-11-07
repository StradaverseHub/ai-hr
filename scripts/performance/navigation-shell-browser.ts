/** Walk only the already permission-filtered native shell. No route, grant or DOM mutation. */
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
const roots=['aside[data-app-sidebar] nav[data-tour="nav"]','[id^="nav-flyout-"] nav','[id^="atelier-flyout-"] nav'];
const controls=roots.map(root=>root+' button[aria-controls][aria-expanded="false"]').join(',');
async function visible(locator:Locator){
 const count=await locator.count();assert(count<=128,'Native shell selector exceeds its bound');
 const result:Locator[]=[];
 for(let i=0;i<count;i++){const item=locator.nth(i);if(await item.isVisible())result.push(item);}
 return result;
}
export async function clickNativeShellDestination(page:Page,href:string,remaining:()=>number){
 assert(/^\/[a-z0-9/-]+$/.test(href),'Only reviewed static shell destinations are supported');
 const sidebar=page.locator('aside[data-app-sidebar]');
 await sidebar.waitFor({state:'visible',timeout:remaining()});
 const target=page.locator(roots.map(root=>root+' a[href='+JSON.stringify(href)+']').join(','));
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
   remaining();const links=await visible(target);assert(links.length<=1,'Native shell destination is ambiguous');
   if(links.length){
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
 }
 throw Error('Reviewed destination is absent from the actual native shell');
}
