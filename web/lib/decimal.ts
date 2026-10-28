import Decimal from "decimal.js";
const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_HALF_UP });
const CompactD = D.clone({ precision: 512 });
function read(value: string | null | undefined): Decimal | null {
  if (typeof value !== "string" || value.length > 512 || !value.trim())
    return null;
  try {
    const n = new D(value);
    return n.isFinite() ? n : null;
  } catch {
    return null;
  }
}
function grouped(value: string): string {
  const [integer, fraction] = value.split(".");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "")
  );
}
export function formatUsd(value: string | null | undefined): string {
  const n = read(value);
  if (!n) return "—";
  const sign = n.isNegative() && !n.isZero() ? "-" : "";
  if (!n.isZero() && n.abs().lessThan("0.01")) return sign + "<$0.01";
  return sign + "$" + grouped(n.abs().toFixed(2));
}
/** Token unit prices retain five significant digits below one cent. */
export function formatPrice(value: string | null | undefined): string {
  const n = read(value);
  if (!n) return "—";
  if (n.isZero() || n.abs().greaterThanOrEqualTo("0.01"))
    return formatUsd(value);
  const rounded = n.abs().toSignificantDigits(5).toFixed();
  return (n.isNegative() ? "-" : "") + "$" + rounded;
}
export function formatAmount(
  value: string | null | undefined,
  maxFractionDigits = 6,
): string {
  const n = read(value);
  if (!n) return "—";
  const digits = Math.min(20, Math.max(0, maxFractionDigits));
  const sign = n.isNegative() && !n.isZero() ? "-" : "";
  if (!n.isZero() && n.abs().lessThan(new D(10).pow(-digits)))
    return sign + "<" + new D(10).pow(-digits).toFixed(digits);
  const fixed = n
    .abs()
    .toFixed(digits)
    .replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return sign + grouped(fixed);
}
/** Compact token quantities only; full amounts remain available in the details. */
export function formatCompactAmount(
  value: string | null | undefined,
): string {
  const n = read(value);
  if (!n) return "—";
  if (n.abs().lessThan("1000")) return formatAmount(value);
  // Retain every accepted input digit while scaling, including values beyond
  // the precision needed for on-chain balances or JavaScript's safe integers.
  const magnitude = new CompactD(n).abs();
  const units = [
    { scale: "1000", suffix: "K" },
    { scale: "1000000", suffix: "M" },
    { scale: "1000000000", suffix: "B" },
  ];
  let index = magnitude.greaterThanOrEqualTo(units[2].scale)
    ? 2
    : magnitude.greaterThanOrEqualTo(units[1].scale)
      ? 1
      : 0;
  let scaled = magnitude.div(units[index].scale).toDecimalPlaces(2);
  if (index < units.length - 1 && scaled.greaterThanOrEqualTo("1000")) {
    index += 1;
    scaled = magnitude.div(units[index].scale).toDecimalPlaces(2);
  }
  const fixed = scaled.toFixed(2).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  return (n.isNegative() ? "-" : "") + grouped(fixed) + units[index].suffix;
}
export function compareDecimalDesc(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const x = read(a),
    y = read(b);
  return x && y ? y.comparedTo(x) : x ? -1 : y ? 1 : 0;
}
export function atomsToUi(
  value: string | null | undefined,
  decimals: number,
): string | null {
  const n = read(value);
  if (!n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    return null;
  return n.div(new D(10).pow(decimals)).toFixed();
}
