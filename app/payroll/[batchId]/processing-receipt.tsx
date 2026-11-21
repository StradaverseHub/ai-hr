'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { requestPayrollProcessingReceipt } from '../actions';

type Receipt = Awaited<ReturnType<typeof requestPayrollProcessingReceipt>>;

/** After hydration, post the same form and let the register refresh separately. */
export function PayrollProcessingReceipt({ children, unavailable }: { children: ReactNode; unavailable: string }) {
  const router = useRouter();
  const fields = useRef<HTMLFieldSetElement>(null);
  const submitting = useRef(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = fields.current?.form;
    if (!form) return;

    async function submit(event: SubmitEvent) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (!form || submitting.current) return;
      submitting.current = true;
      const data = new FormData(form);
      setPending(true);
      setReceipt(null);
      try {
        const result = await requestPayrollProcessingReceipt(data);
        if (!form.isConnected) return;
        setReceipt(result);
        if (result.status === 'queued') {
          const current = new URL(form.ownerDocument.location.href);
          if (current.searchParams.has('error')) {
            current.searchParams.delete('error');
            router.replace(current.pathname + current.search, { scroll: false });
          } else {
            router.refresh();
          }
          return;
        }
      } catch {
        if (form.isConnected) {
          setReceipt({ status: 'refused', message: unavailable });
          router.refresh();
        }
      } finally {
        setPending(false);
      }
      submitting.current = false;
    }

    form.addEventListener('submit', submit);
    return () => form.removeEventListener('submit', submit);
  }, [router, unavailable]);

  return (
    <fieldset ref={fields} disabled={pending || receipt?.status === 'queued'} aria-busy={pending} className="min-w-0">
      {children}
      {receipt && (
        <p
          role={receipt.status === 'queued' ? 'status' : 'alert'}
          className={receipt.status === 'queued' ? 'mt-1 text-sm text-muted-foreground' : 'mt-1 text-sm text-destructive'}
        >
          {receipt.message}
        </p>
      )}
    </fieldset>
  );
}
