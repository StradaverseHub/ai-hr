import source from './guide-screen-source.json';
const injection=source._INJECTION_RES.map(r=>new RegExp(r,'im')),forbidden=source._NOT_ALLOWED_RES.map(r=>new RegExp(r,'im')),offtopic=source._OFFTOPIC_RES.map(r=>new RegExp(r,'im')),review=new RegExp(source._REVIEW_SIGNAL_RE,'i');
const leet:Record<string,string>={'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i'};
const translate=(s:string)=>s.replace(/[013457@$!]/g,c=>leet[c]);
const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
/** Source screening normalization, including encoded prompt overrides; all refusal output is fixed copy. */
export function screenPerformanceQuestion(text:string){
 const t=normalize(text.normalize('NFKC')),variants=[t,translate(t)];
 if((text.match(/(?:^|\s)[A-Za-z0-9@$](?=\s|$)/g)??[]).length>=5){
  const spaced=normalize(text.trim().split(/\s{2,}|\s*[/|]\s*/).map(c=>/^(?:\S ){2,}\S$/.test(c.trim())?c.replace(/ /g,''):c).join(' '));variants.push(spaced,translate(spaced));
  const squashed=translate(text.toLowerCase()).replace(/[^a-z]/g,'');if(['ignoreall','ignoreprevious','ignoreyour','disregardall','disregardprevious','forgetall','forgetyour','systemprompt','developermode','jailbreak','abaikansemua','revealyour'].some(s=>squashed.includes(s)))variants.push('ignore all previous instructions');
 }
 variants.push(t.replace(/[a-zA-Z]/g,c=>String.fromCharCode(c.charCodeAt(0)+(c.toLowerCase()<='m'?13:-13))));
 for(const blob of t.match(/[A-Za-z0-9+/]{24,}={0,2}/g)??[])try{const decoded=Buffer.from(blob,'base64').toString('utf8');if(decoded&&(decoded.match(/[^\x00-\x1f\x7f\ufffd]/g)??[]).length/decoded.length>.9)variants.push(normalize(decoded));}catch{/* malformed encoded data is not an instruction */}
 if(variants.some(v=>injection.some(r=>r.test(v))))return 'injection';
 if(forbidden.some(r=>r.test(t)))return 'not_allowed';
 if(offtopic.some(r=>r.test(t))&&!review.test(t))return 'offtopic';
 return null;
}
