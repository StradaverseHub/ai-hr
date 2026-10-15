import performanceCatalogue from './performance-help-catalogue.json';
const stopwords=new Set(['what','how','does','the','are','and','for','about','this','that','you','your','with','when','from','into','them','they','can','will','would','should','please','tell','explain','mean','means','work','works','here']);
/** Source FAQ ranking: any significant word, most matches first, stable catalogue order, first three fallback. */
export function rankKnowledgeArticles<T extends {title:string;body:string;tags?:string}>(query:string,rows:T[]):T[]{
 const words=(query.toLowerCase().match(/[a-z0-9]+/g)??[]).filter(w=>w.length>=3&&!stopwords.has(w));
 const ranked=rows.map((row,index)=>({row,index,score:words.reduce((n,w)=>n+Number(`${row.title} ${row.tags??''} ${row.body}`.toLowerCase().includes(w)),0)})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.index-b.index);
 return (ranked.length?ranked.map(r=>r.row):rows).slice(0,3);
}
export function assessmentHelpQuery(text:string):string|null{
 const literal=/^(?:help|search (?:the )?(?:help|knowledge base)):\s*([\s\S]+)$/i.exec(text.trim());if(literal)return literal[1].trim();
 return /^(?:what (?:is|are|does)|how (?:do|does|can|is)|who can|why (?:is|are|does))\b/i.test(text.trim())&&/\b(?:kpi|calibration|competenc\w*|360|career|development|mobility|rating|potential|confidential\w*|anonymous|review|submit|star|smart)\b/i.test(text)?text.trim():null;
}

/** Preserve the imported guide's search tags and ordering while reading the editable native article text. */
export function rankPerformanceArticles<T extends {slug:string|null;title:string;body:string}>(query:string,rows:T[]):T[]{
 const metadata=new Map(performanceCatalogue.map(r=>[r.slug,r]));
 const ordered=rows.map((row,index)=>({row,index,meta:metadata.get(row.slug??'')})).sort((a,b)=>(a.meta?.order??Number.MAX_SAFE_INTEGER)-(b.meta?.order??Number.MAX_SAFE_INTEGER)||a.index-b.index);
 return rankKnowledgeArticles(query,ordered.map(({row,meta})=>({...row,tags:meta?.tags??''})));
}

/** Personal dashboard search excludes scoring-method entries and has no arbitrary fallback. */
export function rankPerformanceDashboardArticles<T extends {slug:string|null;title:string;body:string}>(query:string,rows:T[]):T[]{
 const hidden=new Set(['performance-faq-rating-scale','performance-faq-potential-band','performance-faq-good-360-comment']);
 const metadata=new Map(performanceCatalogue.map(r=>[r.slug,r]));
 const words=(query.toLowerCase().match(/[a-z0-9]+/g)??[]).filter(w=>w.length>=3&&!stopwords.has(w));
 return rows.filter(r=>!hidden.has(r.slug??'')).map((row,index)=>{const meta=metadata.get(row.slug??'');return {row,index,order:meta?.order??Number.MAX_SAFE_INTEGER,score:words.reduce((n,w)=>n+3*Number(row.title.toLowerCase().includes(w))+2*Number((meta?.tags??'').toLowerCase().includes(w))+Number(row.body.toLowerCase().includes(w)),0)};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.order-b.order||a.index-b.index).slice(0,3).map(r=>r.row);
}
