import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A same-app path the reply may link to: one leading slash and no scheme, host or backslash. The reply checks
 * (core/harness/reply-checks.ts destination_links) have already refused any path that is not one of this person's
 * product destinations before the reply reaches here; this is the renderer's own floor. */
export const isInAppPath = (href: string | undefined): href is string =>
  typeof href === 'string' && /^\/(?![\/\\])[A-Za-z0-9\-._~%/?=&#[\]]*$/.test(href) && !/[\\]|^\/{2}/.test(href);

/** The Noveri reply as written: paragraphs, bullet and numbered lists, bold, and links to in-app destinations only.
 * Raw HTML stays escaped (react-markdown without rehype-raw); headings, tables, code, quotes and images are not
 * rendered as such (their text is kept, an image is dropped); any other link is plain text. Staging acceptance,
 * 3 November 2026: replies showed literal **asterisks** because the text was printed as-is. */
export function ReplyMarkdown({ text }: { text: string }) {
  return (
    <div data-teras-text className="space-y-2 break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={['p', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'br']}
        unwrapDisallowed
        components={{
          p: ({ children }) => <p className="whitespace-pre-line">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          a: ({ href, children }) => isInAppPath(href)
            ? <Link href={href} className="font-medium text-primary underline underline-offset-2 hover:no-underline">{children}</Link>
            : <span>{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
