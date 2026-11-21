'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { requestPayrollProcessingReceipt } from '../actions';

type Receipt = Awaited<ReturnType<typeof requestPayrollProcessingReceipt>>;
type Feedback = { receipt: Receipt; refresh: boolean; finishedAt: string | null };

/** Keep the acknowledgement mounted as the register removes the draft form. */
export function PayrollProcessingReceipt({ children, unavailable, finishedAt }: {
  children?: ReactNode;
  unavailable: string;
  finishedAt: string | null;
}) {
  const router = useRouter();
  const sending = useRef(false);
  const refreshedFeedback = useRef<Feedback | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pending, setPending] = useState(false);
  const visibleFeedback = children && feedback?.finishedAt !== finishedAt ? null : feedback;

  useEffect(() => {
    if (!feedback?.refresh || refreshedFeedback.current === feedback) return;
    refreshedFeedback.current = feedback;
    const current = new URL(window.location.href);
    if (feedback.receipt.status === 'queued' && current.searchParams.has('error')) {
      current.searchParams.delete('error');
      router.replace(current.pathname + current.search, { scroll: false });
    } else {
      router.refresh();
    }
  }, [feedback, router]);

  async function submit(event: FormEvent<HTMLFieldSetElement>) {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (sending.current || visibleFeedback?.receipt.status === 'queued') return;
    sending.current = true;
    const data = new FormData(event.target);
    setPending(true);
    setFeedback(null);
    try {
      const receipt = await requestPayrollProcessingReceipt(data);
      setFeedback({ receipt, refresh: receipt.status === 'queued', finishedAt });
    } catch {
      setFeedback({ receipt: { status: 'refused', message: unavailable }, refresh: true, finishedAt });
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  const receipt = visibleFeedback?.receipt;
  return (
    <>
      {children && (
        <fieldset disabled={pending || receipt?.status === 'queued'} aria-busy={pending} onSubmit={submit} className="min-w-0">
          {children}
        </fieldset>
      )}
      {receipt && (
        <p
          role={receipt.status === 'queued' ? 'status' : 'alert'}
          className={receipt.status === 'queued' ? 'mt-1 text-sm text-muted-foreground' : 'mt-1 text-sm text-destructive'}
        >
          {receipt.message}
        </p>
      )}
    </>
  );
}
