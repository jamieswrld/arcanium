import type { ReactNode } from "react";

export interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <section className="arch-card">
      {title !== undefined ? (
        <h2 className="m-0 mb-3 text-base font-semibold">{title}</h2>
      ) : null}
      {children}
    </section>
  );
}
