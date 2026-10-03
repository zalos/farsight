import type { ReactNode } from 'react';

/** The frame every screen sits in: a title and its content. */
export function PageShell({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
