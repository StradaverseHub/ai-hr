/** Browser-only measurement. Intersection is observed; available clipping space is independent. */
export async function resignationCaptureGeometry(element){
 const bounds=rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
 const establishesFixedBlock=style=>style.transform!=='none'||style.perspective!=='none'||style.filter!=='none'||(style.backdropFilter&&style.backdropFilter!=='none')||/(layout|paint|strict|content)/.test(style.contain)||/(transform|perspective|filter)/.test(style.willChange)||style.contentVisibility==='auto';
 const fixedBlock=node=>{for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.matches(':modal')||establishesFixedBlock(getComputedStyle(parent)))return parent;return null;};
 const r=element.getBoundingClientRect(),parents=[],ancestors=[];
 let left=0,top=0,right=innerWidth,bottom=innerHeight;
 let skipUntil=getComputedStyle(element).position==='fixed'?fixedBlock(element):undefined;
 if(element.matches(':modal'))skipUntil=null;
 for(let p=element.parentElement;p;p=p.parentElement){
  const style=getComputedStyle(p),rect=p.getBoundingClientRect();
  const applies=skipUntil===undefined||skipUntil===p;
  ancestors.push({tag:p.tagName,role:p.getAttribute('role'),position:style.position,overflowX:style.overflowX,overflowY:style.overflowY,transform:style.transform,perspective:style.perspective,filter:style.filter,backdropFilter:style.backdropFilter,contain:style.contain,willChange:style.willChange,contentVisibility:style.contentVisibility,modal:p.matches(':modal'),clipApplies:applies,bounds:bounds(rect)});
  if(!applies)continue;
  skipUntil=undefined;
  const x=rect.left+p.clientLeft,y=rect.top+p.clientTop;
  if(/auto|scroll|hidden|clip/.test(style.overflowY)||/(paint|strict|content)/.test(style.contain)){top=Math.max(top,y);bottom=Math.min(bottom,y+p.clientHeight);}
  if(/auto|scroll|hidden|clip/.test(style.overflowX)||/(paint|strict|content)/.test(style.contain)){left=Math.max(left,x);right=Math.min(right,x+p.clientWidth);}
  if(/auto|scroll/.test(style.overflowY)&&p.scrollHeight>p.clientHeight)parents.push({tag:p.tagName,role:p.getAttribute('role'),scrollTop:p.scrollTop,clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,bounds:{top:rect.top,bottom:rect.bottom}});
  // A modal is in the top layer. Its DOM ancestors cannot clip it or its descendants.
  if(p.matches(':modal')){skipUntil=null;continue;}
  if(style.position==='fixed')skipUntil=fixedBlock(p);
 }
 const observed=await new Promise(resolve=>{const observer=new IntersectionObserver(entries=>{const entry=entries[0];observer.disconnect();resolve({intersection:bounds(entry.intersectionRect),rootBounds:entry.rootBounds?bounds(entry.rootBounds):null,isIntersecting:entry.isIntersecting,ratio:entry.intersectionRatio});},{root:null,threshold:[0,1]});observer.observe(element);});
 return{bounds:bounds(r),viewport:{width:innerWidth,height:innerHeight},scrollParents:parents,ancestors,clip:{left,top,width:Math.max(0,right-left),height:Math.max(0,bottom-top)},visibleHeight:observed.intersection.height,visibleWidth:observed.intersection.width,observed};
}
