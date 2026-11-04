import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A same-app path the reply may link to: one leading slash and no scheme, host or backslash. The reply checks
 * (the harness's destination_links check, reached only through core/teras-wiring) have already refused any path that is not one of this person's
 * product destinations before the reply reaches here; this is the renderer's own floor. */
export const isInAppPath = (href: string | undefined): href is string =>
  typeof href === 'string' && /^\/(?![\/\\])[A-Za-z0-9\-._~%/?=&#[\]]*$/.test(href) && !/[\\]|^\/{2}/.test(href);

/** This caller's linkable destinations: normalised path → the registry's localised title, or null where the registry
 * has none (the model's label is then kept). Built per caller by the turn's action (app/assistant/launcher-actions.ts). */
export type ReplyLinks = ReadonlyMap<string, string | null>;
export const linkKey = (href: string) => href.split(/[?#]/)[0].replace(/\/$/, '') || '/';

/** The Noveri reply as written: paragraphs, bullet and numbered lists, bold, and links to in-app destinations only.
 * Raw HTML stays escaped (react-markdown without rehype-raw); headings, tables, code, quotes and images are not
 * rendered as such (their text is kept, an image is dropped); any other link is plain text. Staging acceptance,
 * 3 November 2026: replies showed literal **asterisks** because the text was printed as-is. */
export function ReplyMarkdown({ text, links }: { text: string; links: ReplyLinks }) {
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
          // A link renders only for a destination this caller may open, labelled with the registry's own title so a
          // model label cannot misdescribe the page; anything else is its label as plain text, never raw brackets.
          a: ({ href, children }) => {
            if (!isInAppPath(href) || !links.has(linkKey(href))) return <span>{children}</span>;
            const title = links.get(linkKey(href));
            return <Link href={href} className="font-medium text-primary underline underline-offset-2 hover:no-underline">{title ?? children}</Link>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
