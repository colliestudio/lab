import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { imageSrc } from "./registry.ts";

/** An image that opens full size in a lightbox on click (Esc, click or × closes). */
export function ZoomImg({ src, alt = "", zoom = true, style, className, loading = "eager" }: {
  src: string; alt?: string; zoom?: boolean; style?: CSSProperties; className?: string; loading?: "lazy" | "eager";
}) {
  const [open, setOpen] = useState(false);
  const url = imageSrc(src);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [open]);
  return (
    <>
      <img src={url} alt={alt} loading={loading} className={className} style={zoom ? { cursor: "zoom-in", ...style } : style} onClick={zoom ? (e) => { e.stopPropagation(); setOpen(true); } : undefined} />
      {open && createPortal(
        <div className="a-lightbox" role="dialog" aria-label="Image" onClick={() => setOpen(false)}>
          <img src={url} alt={alt} />
          <button aria-label="Close" onClick={() => setOpen(false)}>×</button>
        </div>, document.body)}
    </>
  );
}
