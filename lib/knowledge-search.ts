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
