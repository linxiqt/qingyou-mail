import { BlockList, isIP } from "node:net";
import { AppError, domainName } from "./security.js";

export const getSetting = (db, key, fallback = {}) => ({
  ...fallback,
  ...JSON.parse(
    db.prepare("SELECT value FROM app_settings WHERE key=?").get(key)?.value ||
      "{}",
  ),
});
export function putSetting(db, key, value) {
  db.prepare(
    "INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
  return value;
}
export async function mapConcurrent(items, limit, work) {
  const result = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const i = index++;
        result[i] = await work(items[i], i);
      }
    }),
  );
  return result;
}
export function integer(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new AppError(`${label}需为 ${min}–${max}`);
  return n;
}
export function bool(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new AppError("开关需为布尔值");
  return value;
}
export function domainList(input, fallback = []) {
  const values =
    input === undefined
      ? fallback
      : Array.isArray(input)
        ? input
        : String(input)
            .split(/[,，\s]+/)
            .filter(Boolean);
  if (values.length > 100) throw new AppError("最多选择100个域名");
  return [...new Set(values.map(domainName))];
}
export function ipRules(input = "") {
  const values = Array.isArray(input)
    ? input
    : String(input)
        .split(/[,，\s]+/)
        .filter(Boolean);
  if (values.length > 100) throw new AppError("最多100条IP规则");
  const list = new BlockList();
  for (const raw of values) {
    const [address, prefix, ...extra] = String(raw).split("/");
    const family = isIP(address);
    if (
      !family ||
      extra.length ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    )
      throw new AppError(`IP/CIDR格式无效：${raw}`);
    if (prefix === undefined)
      list.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else
      list.addSubnet(address, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return {
    text: values.join("\n"),
    test(value) {
      let address = String(value || "").replace(/^::ffff:/i, "");
      const family = isIP(address);
      return (
        values.length === 0 ||
        Boolean(family && list.check(address, family === 4 ? "ipv4" : "ipv6"))
      );
    },
  };
}
