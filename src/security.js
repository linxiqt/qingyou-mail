import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import { domainToASCII } from "node:url";
const scrypt = promisify(scryptCallback);

export class AppError extends Error {
  constructor(message, status = 400, smtpCode = 550) {
    super(message);
    this.status = status;
    this.responseCode = smtpCode;
  }
}
export const token = (size = 32) => randomBytes(size).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a, b) => {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
};
export function passwordValid(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new AppError("密码需为 12–256 个字符");
  return value;
}
export async function hashPassword(password) {
  passwordValid(password);
  const salt = token(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, hash) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [, salt, stored] = (hash || "").split(":");
  // Compute even for missing users to reduce account enumeration by timing.
  const computed = await scrypt(password, salt || "missing-account-salt", 64);
  return Boolean(stored) && equal(computed.toString("hex"), stored);
}
export function domainName(value) {
  const name = domainToASCII(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
  if (
    name.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      name,
    )
  )
    throw new AppError("请输入有效域名，例如 example.com");
  return name;
}
export function emailAddress(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  const parts = email.split("@");
  if (
    parts.length !== 2 ||
    parts[0].length > 64 ||
    !/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/.test(parts[0])
  )
    throw new AppError(`邮箱地址无效：${email.slice(0, 80)}`);
  return `${parts[0]}@${domainName(parts[1])}`;
}
export function recipients(value, required = false) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[,;，；\s]+/)
        .filter(Boolean);
  if (values.length > 100) throw new AppError("单封邮件最多 100 个收件人");
  const result = [
    ...new Set(
      values.map((v) => emailAddress(typeof v === "object" ? v.address : v)),
    ),
  ];
  if (required && !result.length) throw new AppError("请填写收件人");
  return result;
}
export function textValue(value, max = 200) {
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw new AppError("字段内容无效或过长");
  return value.trim();
}
export function idValue(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError("记录编号无效");
  return id;
}
export function makeWindowLimiter(max, windowMs) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    if (buckets.size > 10000)
      for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    let entry = buckets.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      buckets.set(key, entry);
    }
    if (++entry.count > max)
      throw new AppError("操作过于频繁，请稍后重试", 429, 451);
  };
}
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    quota_bytes: user.quota_bytes,
    created_at: user.created_at,
  };
}
