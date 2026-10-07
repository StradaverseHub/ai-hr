'use client';

import * as React from 'react';
import { Section, type SectionTab } from './section';

/**
 * r401 — the section's mono INDEX (`01 · Attendance`) on a screen whose sections the USER arranges (the
 * customizable Dashboard). A server-rendered section cannot know where it will land: the customizer decides
 * the order on the client, live, while the user drags. So the customizer hands each section block its
 * position through this context, and `OrdinalSection` reads it. Outside a provider there is no index — the
 * header then shows the label alone, which is the honest answer when nothing has placed the section.
 */
const SectionOrdinalContext = React.createContext<number | undefined>(undefined);

export function SectionOrdinalProvider({ value, children }: { value: number | undefined; children: React.ReactNode }) {
  return <SectionOrdinalContext.Provider value={value}>{children}</SectionOrdinalContext.Provider>;
}

export function useSectionOrdinal(): number | undefined {
  return React.useContext(SectionOrdinalContext);
}

/** A `Section` whose index is its place on the screen, from the nearest `SectionOrdinalProvider`. */
export function OrdinalSection(props: {
  label?: React.ReactNode;
  tabs?: SectionTab[];
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const index = useSectionOrdinal();
  const { id, ...rest } = props;
  const section = <Section index={index} {...rest} />;
  // An in-page anchor target (`#upcoming-events`) needs an element with the id; Section takes none.
  return id ? (
    <div id={id} className="h-full scroll-mt-4">
      {section}
    </div>
  ) : (
    section
  );
}
