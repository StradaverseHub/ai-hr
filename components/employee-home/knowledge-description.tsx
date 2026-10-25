'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';

/** Same parser as the library viewer, with a text-only result surface. No image, embedded content,
 * raw HTML or external hyperlink mounts while someone is only reviewing a search result. */
export default function KnowledgeDescription({markdown}:{markdown:string}){
  return <div className="line-clamp-2 min-w-0 text-sm leading-relaxed text-muted-foreground">
    <ReactMarkdown remarkPlugins={[remarkGfm,remarkCjkFriendly]} skipHtml
      allowedElements={['p','strong','em','del','code','br']} unwrapDisallowed
      components={{p:({children})=><span>{children} </span>}}>{markdown}</ReactMarkdown>
  </div>;
}
