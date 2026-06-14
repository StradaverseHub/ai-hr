'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { cn } from '@/lib/utils';

/**
 * Markdown renderer for Knowledge Base articles (ADR-0017). react-markdown does NOT pass raw HTML
 * through (no rehype-raw), so user-authored Markdown can't inject script/stored-XSS. Element styles
 * map to the design tokens — no @tailwindcss/typography dependency.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('max-w-[72ch] text-sm leading-relaxed text-foreground/90', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCjkFriendly]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-6 text-2xl font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-7 border-b border-border pb-1.5 text-lg font-semibold tracking-tight text-foreground first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-5 text-base font-semibold text-foreground">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-4 text-sm font-semibold text-foreground">{children}</h4>
          ),
          p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="font-medium text-primary underline underline-offset-2 hover:no-underline"
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-primary/30 pl-4 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ className: c, children }) => {
            const isBlock = /language-/.test(c ?? '');
            if (isBlock) return <code className={c}>{children}</code>;
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-muted/60 p-3 font-mono text-xs leading-relaxed">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-6 border-border" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
          th: ({ children }) => (
            <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border px-3 py-1.5 align-top">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
