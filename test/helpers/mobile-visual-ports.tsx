/** Native presentation boundary for journey fixtures; values/actions remain the shipped components'. */
import * as React from 'react';
export const mobileVisualPorts = {
  Material: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  TimeDisplay: ({ label }: { label: string }) => <span aria-label={label}>{label}</span>,
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
  alpha: (color: string) => color,
};
