'use client';

import * as React from 'react';
import {Button} from '@/components/ui';
import {Card,CardContent,CardHeader} from '@/components/ui/card';
import type {EmployeeHomeCard} from '@/lib/employee-home';
import {deliverHomeCard,type HomeCardDelivery,type HomeCardReader} from '@/lib/employee-home-delivery';

type Labels={loading:string;failed:string;timeout:string;retry:string;refresh:string};
type View<T>={key:string;result:HomeCardDelivery<T>|{state:'loading'}};

class CardRenderBoundary extends React.Component<{
  children:React.ReactNode;fallback:React.ReactNode;onFailure:()=>void;
},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(){this.props.onFailure();}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
}
function DeliveredBody<T>({value,render}:{value:T;render:(value:T)=>React.ReactNode}){
  return render(value);
}

/** Client-side composition boundary. Supply a stable reader from the client card owner, not an
 * unserializable function through a Server Component. Empty/unavailable facts belong to that owner's
 * typed result; a failed transport must never be reinterpreted as an empty list or a calm summary.
 */
export function IndependentHomeCard<T>({card,title,labels,requestKey,read,children,className,regionRef,footer}:{
  card:EmployeeHomeCard;title:string;labels:Labels;requestKey:string;read:HomeCardReader<T>;
  children:(value:T)=>React.ReactNode;className?:string;
  regionRef?:React.Ref<HTMLDivElement>;
  footer?:React.ReactNode;
}){
  const titleId=React.useId();
  const [attempt,setAttempt]=React.useState(0);
  const key=JSON.stringify([requestKey,attempt]);
  const [view,setView]=React.useState<View<T>>({key,result:{state:'loading'}});
  const result=view.key===key?view.result:{state:'loading' as const};
  const loading=result.state==='loading';
  const failed=result.state==='failed';
  React.useEffect(()=>{
    const controller=new AbortController();
    let current=true;
    setView({key,result:{state:'loading'}});
    void deliverHomeCard(read,{signal:controller.signal}).then(next=>{
      if(current&&next.state!=='cancelled')setView({key,result:next});
    });
    return ()=>{current=false;controller.abort();};
  },[key,read]);
  const renderFailed=React.useCallback(()=>{
    setView({key,result:{state:'failed',reason:'unavailable'}});
  },[key]);
  const failure=<p role="alert" className="text-sm leading-relaxed">{result.state==='failed'&&result.reason==='timeout'?labels.timeout:labels.failed}</p>;
  return <Card ref={regionRef} tabIndex={regionRef?-1:undefined} role="region" aria-labelledby={titleId} aria-busy={loading} data-home-card={card} className={className}>
    <CardHeader className="gap-3">
      <h2 id={titleId} className="min-w-0 text-base font-semibold">{title}</h2>
      <Button type="button" variant="outline" className="h-11 shrink-0 px-3" disabled={loading}
        aria-label={`${failed?labels.retry:labels.refresh}: ${title}`} onClick={()=>setAttempt(value=>value+1)}>
        {loading?labels.loading:failed?labels.retry:labels.refresh}
      </Button>
    </CardHeader>
    <CardContent className="min-w-0 space-y-6">
      {loading?<p role="status" className="min-h-24 text-sm leading-relaxed text-muted-foreground">{labels.loading}</p>:
        failed?failure:result.state==='ready'?<CardRenderBoundary key={key} fallback={failure} onFailure={renderFailed}>
          <DeliveredBody value={result.value} render={children}/>
        </CardRenderBoundary>:null}
      {footer}
    </CardContent>
  </Card>;
}
