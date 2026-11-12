import { Fragment } from 'react';
import type { EmailAsset } from '@/lib/lifecycle-v9-model';
/** React renders text as text; only known private image receipts become image elements. */
export function EmailBodyPreview({ body, assets = [], html }: { body: string; assets?: EmailAsset[]; html?: string }) {
  // Board 6bdda222: a rich body is the renderer's sanitised HTML (values escaped); CID images point at the private asset route.
  if (html) return <div data-preview-html dangerouslySetInnerHTML={{ __html: html.replace(/src="cid:v9-image\.([0-9a-f-]{36})@aihr"/g, (_, id: string) => `src="/lifecycle/v9/email-assets/${id}"`) }}/>;
  return <div style={{ whiteSpace: 'pre-wrap' }}>{body.split(/(\{image:[^{}\s]+\})/g).map((part,index)=>{
    const token=part.match(/^\{image:([^{}\s]+)\}$/),image=token?assets.find(asset=>asset.kind==='image'&&asset.id===token[1]):null;
    return image?<img key={index} src={`/lifecycle/v9/email-assets/${image.id}`} alt={image.name} style={{maxWidth:'100%',height:'auto'}}/>:<Fragment key={index}>{part}</Fragment>;
  })}</div>;
}
