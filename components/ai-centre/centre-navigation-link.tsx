'use client';
import NextLink from 'next/link';
import {useEffect,useRef,type ComponentProps} from 'react';
import IntentLink from '../intent-link';

/** Per-control readiness: the child Next Link has committed before this effect marks its anchor.
 * No delay, permission decision or navigation gate; server-rendered links remain ordinary links.
 * intent=false retains the existing plain Next Link behavior for Ask footer/shortcut links. */
export function CentreNavigationLink({intent=true,...props}:Omit<ComponentProps<typeof NextLink>,'ref'>&{intent?:boolean}){
 const anchor=useRef<HTMLAnchorElement>(null);
 useEffect(()=>{anchor.current?.setAttribute('data-ai-centre-link-ready','true');},[]);
 const Link=intent?IntentLink:NextLink;
 return <Link {...props} ref={anchor} data-ai-centre-link-ready="false"/>;
}
