'use client';
import {TemplateRoutingEditor,type RoutingChoices} from '../probation/templates/routing-editor';
import type {DocumentRouting} from '@/lib/document-signing-routing';
import type {Block} from '@/lib/lifecycle-v9-model';
/** Native registry definitions only. The caller freezes this version's routing when generating a document. */
export function NativeTemplateRoutingEditor({routing,blocks,choices,disabled,onRoutingChange,onBlocksChange}:{routing:DocumentRouting;blocks:readonly Block[];choices:RoutingChoices;disabled:boolean;onRoutingChange:(routing:DocumentRouting)=>void;onBlocksChange:(blocks:Block[])=>void}){
 return <TemplateRoutingEditor value={routing} blocks={blocks} choices={choices} editable={!disabled} onChange={onRoutingChange} onBlocksChange={onBlocksChange} newId={()=>crypto.randomUUID()}/>;
}
