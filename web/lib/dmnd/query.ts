import type { ResourceName, ResourceQuery } from "./contracts";
export function validTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, y, m, d, h, min, sec, zone] = match;
  const month = Number(m),
    year = Number(y),
    day = Number(d);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    Number(h) < 24 &&
    Number(min) < 60 &&
    Number(sec) < 60 &&
    (zone === "Z" ||
      (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4, 6)) < 60))
  );
}
export function parseResourceQuery(
  resource: ResourceName,
  params: URLSearchParams,
): ResourceQuery | null {
  const allowed = ["summary", "overview", "liquid-staking"].includes(resource)
    ? []
    : ["transactions", "activity"].includes(resource)
      ? ["limit", "cursor", "from", "to"]
      : ["limit", "cursor"];
  for (const key of params.keys())
    if (!allowed.includes(key) || params.getAll(key).length !== 1) return null;
  const query: ResourceQuery = {};
  const limit = params.get("limit");
  if (limit !== null) {
    const maximum = resource === "transactions" ? 25 : 100;
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > maximum)
      return null;
    query.limit = Number(limit);
  }
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (!cursor || cursor.length > 8192) return null;
    query.cursor = cursor;
  }
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value !== null) {
      if (!validTimestamp(value)) return null;
      query[key] = value;
    }
  }
  if (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    return null;
  return query;
}
