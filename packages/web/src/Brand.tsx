// The brand mark.
//
// The art is not inlined here on purpose: it is a traced SVG (assets/logo/agentus-icon.svg,
// built from the master PNG by scripts/build-brand-assets.py) that weighs ~20KB, and inlining
// it would put that into every JS bundle for three call sites. Shipping it as a file means the
// browser caches it once — at the price of not being able to recolour it in CSS, which is why
// there is one file per palette and this component picks between them.
import { useResolvedDark } from "./theme";

export function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  const dark = useResolvedDark();
  return (
    <img
      className="brand-mark"
      src={dark ? "/icons/agentus-mark-inverse.svg" : "/icons/agentus-mark.svg"}
      // the mark's own box is 1484x880: height follows width so the <img> hugs the art
      width={size}
      height={Math.round(size * (880 / 1484))}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
