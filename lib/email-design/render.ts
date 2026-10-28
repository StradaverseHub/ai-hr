import {emailDocument,defaultEmailDocument,emailPlaceholders,secureEmailUrl,type EmailKind} from './model';
export type EmailSystemContent={subject:string;text:string;link?:string};
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
/** Runtime data belongs to a recipient owner. Admin content is always escaped, never executable HTML. */
export function renderEmailDesign(raw:unknown|null,kind:EmailKind,locale:string,system:EmailSystemContent,data:Readonly<Record<string,string>>={}){
 const doc=emailDocument.parse(raw??defaultEmailDocument(kind));if(doc.kind!==kind)throw Error('Wrong email design kind.');
 const allowed=new Set(emailPlaceholders(kind));
 const fill=(value:string)=>value.replace(/\{([a-z_]+)\}/g,(_,key:string)=>allowed.has(key)?data[key]??'':'');
 const link=system.link?secureEmailUrl.parse(system.link):null;
 const systemHtml=escape(system.text).replace(/\n/g,'<br>');
 const text:string[]=[];
 const html=doc.blocks.map(block=>{
  const s=block.style,style=`background:${s.background??'#ffffff'};color:${s.color??'#202020'};`+('font' in s?`font-family:${s.font??'Arial'},sans-serif;font-size:${s.size??16}px;text-align:${s.align??'left'};padding:${s.padding??20}px;`:'padding:24px;font-family:Arial,sans-serif;font-size:16px;');
  let content='';
  switch(block.type){
   case 'header':text.push(fill(block.label));content=(block.src?`<img src="${escape(block.src)}" alt="" width="48" style="max-width:100%;height:auto;vertical-align:middle"> `:'')+escape(fill(block.label));break;
   case 'banner':case 'image':text.push(fill(block.alt));content=`<img src="${escape(block.src)}" alt="${escape(fill(block.alt))}" width="600" style="display:block;width:100%;max-width:100%;height:auto;border:0">`;break;
   case 'text':text.push(fill(block.heading),block.runs.map(run=>fill(run.text)+(run.href?` (${run.href})`:'')).join(''));content=(block.heading?`<h2 style="font-size:1.3em;margin:0 0 12px">${escape(fill(block.heading))}</h2>`:'')+block.runs.map(run=>{let value=escape(fill(run.text)).replace(/\n/g,'<br>');if(run.bold)value=`<strong>${value}</strong>`;if(run.italic)value=`<em>${value}</em>`;return run.href?`<a href="${escape(run.href)}">${value}</a>`:value;}).join('');break;
   case 'button':text.push(`${fill(block.label)}: ${block.href}`);content=`<a href="${escape(block.href)}" style="display:inline-block;padding:12px 20px;background:${s.color??'#222244'};color:${s.background??'#ffffff'};text-decoration:none">${escape(fill(block.label))}</a>`;break;
   case 'columns':text.push(...block.columns.map(col=>`${fill(col.heading)}\n${fill(col.text)}`));content=`<table role="presentation" width="100%"><tr>${block.columns.map(col=>`<td width="50%" valign="top" style="padding:8px"><strong>${escape(fill(col.heading))}</strong><br>${escape(fill(col.text)).replace(/\n/g,'<br>')}</td>`).join('')}</tr></table>`;break;
   case 'divider':content='<hr style="border:0;border-top:1px solid #cccccc">';break;
   case 'spacer':content=`<div style="height:${block.height}px;line-height:${block.height}px">&#160;</div>`;break;
   case 'social':text.push(...block.links.map(value=>`${fill(value.label)}: ${value.href}`));content=block.links.map(value=>`<a href="${escape(value.href)}" style="margin-right:12px">${escape(fill(value.label))}</a>`).join(' ');break;
   case 'footer':text.push(fill(block.text));content=escape(fill(block.text)).replace(/\n/g,'<br>');break;
   case 'system':text.push(system.text);content=link?systemHtml.replaceAll(escape(link),`<a href="${escape(link)}">${escape(link)}</a>`):systemHtml;break;
  }
  return `<tr><td style="${style}">${content}</td></tr>`;
 }).join('');
 const subject=(doc.subject?fill(doc.subject):system.subject).replace(/[\u0000-\u001f\u007f]/g,' ');
 return {subject,text:text.filter(Boolean).join('\n\n'),html:`<!doctype html><html lang="${escape(locale)}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:${doc.background}"><table role="presentation" width="100%" style="background:${doc.background}"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;border-collapse:collapse">${html}</table></td></tr></table></body></html>`};
}
