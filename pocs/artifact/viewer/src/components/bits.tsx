import type { ReactNode } from "react";
import type { Change } from "../../../src/model.ts";
import { CHANGE_LABEL, cx } from "../util.ts";

export function ChangeBadge({ change, short }: { change: Change; short?: boolean }) {
  const letter = { added: "+", changed: "~", removed: "−", unchanged: "·", planned: "◇" }[change];
  return (
    <span className={cx("badge", `ch-${change}`)} title={CHANGE_LABEL[change]}>
      {short ? letter : CHANGE_LABEL[change]}
    </span>
  );
}

export function Pill({ children, tone, className }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={cx("pill", tone && `tone-${tone}`, className)}>{children}</span>;
}

export function AddDel({ add, del }: { add: number; del: number }) {
  return (
    <span className="adddel">
      <span className="add">+{add}</span> <span className="del">−{del}</span>
    </span>
  );
}

/** GitHub-style 5-square churn bar. */
export function ChurnBar({ add, del }: { add: number; del: number }) {
  const total = add + del;
  const n = 5;
  const a = total ? Math.round((add / total) * n) : 0;
  const d = total ? Math.min(n - a, Math.round((del / total) * n)) : 0;
  return (
    <span className="churn" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < a ? "a" : i < a + d ? "d" : ""} />
      ))}
    </span>
  );
}
