/** Solscan's official logo mark (colour). Decorative: the surrounding link carries the accessible name. */
export function SolscanMark({ size = 14 }: { size?: 14 | 16 }) {
  return (
    <img
      src="/brands/solscan.svg"
      alt=""
      width={size}
      height={size}
      decoding="async"
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
