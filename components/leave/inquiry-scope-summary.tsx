/** Scope stays compact until the reader asks to see every company. */
export function InquiryScopeSummary({ heading, companies }: { heading: string; companies: readonly { id: string; name: string }[] }) {
  return <details className="min-w-0 flex-1 text-sm">
    <summary className="cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{heading}</summary>
    <ul className="mt-3 grid max-h-48 list-none gap-1 overflow-y-auto p-0 text-xs font-normal text-muted-foreground sm:grid-cols-2">
      {companies.map(company => <li key={company.id} className="min-w-0 break-words">{company.name}</li>)}
    </ul>
  </details>;
}
