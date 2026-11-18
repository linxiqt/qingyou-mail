import { randomInt } from "node:crypto";
import {
  AppError,
  domainName,
  emailAddress,
  passwordValid,
} from "./security.js";

function integer(value, fallback, min, max, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new AppError(`${label}需为 ${min}–${max}`);
  return n;
}
export function randomString(length, groups) {
  const alphabet = groups.join("");
  const result = groups.map((group) => group[randomInt(group.length)]);
  while (result.length < length)
    result.push(alphabet[randomInt(alphabet.length)]);
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.join("");
}
export function generateAccounts(input, exists) {
  for (const key of [
    "randomUsername",
    "randomPassword",
    "usernameNumbers",
    "usernameUppercase",
    "passwordUppercase",
    "passwordNumbers",
    "passwordSymbols",
  ])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new AppError(`${key} 需为布尔值`);
  const domain = domainName(input.domain);
  const count = integer(input.count, 50, 1, 100, "创建数量");
  const usernameLength = integer(input.usernameLength, 8, 4, 32, "用户名长度");
  const passwordLength = integer(input.passwordLength, 12, 12, 64, "密码长度");
  const start = integer(input.startNumber, 1, 0, 999999999, "起始序号");
  const randomUsername = input.randomUsername !== false;
  const randomPassword = input.randomPassword !== false;
  const prefix = String(input.prefix || "user").trim();
  if (!randomUsername && !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,31}$/.test(prefix))
    throw new AppError("用户名前缀需为 1–32 个字母、数字或 . _ + -");
  if (!randomPassword) passwordValid(input.password);
  const usernameGroups = ["abcdefghijklmnopqrstuvwxyz"];
  if (input.usernameNumbers !== false) usernameGroups.push("0123456789");
  if (input.usernameUppercase === true)
    usernameGroups.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const passwordGroups = ["abcdefghijklmnopqrstuvwxyz"];
  if (input.passwordUppercase !== false)
    passwordGroups.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  if (input.passwordNumbers !== false) passwordGroups.push("0123456789");
  if (input.passwordSymbols !== false) passwordGroups.push("!@#$%^&*_-+=?");
  const reserved = new Set();
  const entries = [];
  for (let i = 0; i < count; i++) {
    let local, canonical;
    for (let attempt = 0; attempt < 100; attempt++) {
      local = randomUsername
        ? randomString(usernameLength, usernameGroups)
        : `${prefix}${String(start + i).padStart(Math.max(2, String(start + count - 1).length), "0")}`;
      canonical = emailAddress(`${local}@${domain}`);
      if (!reserved.has(canonical) && !exists(canonical)) break;
      if (!randomUsername || attempt === 99)
        throw new AppError(`邮箱已存在或生成空间不足：${canonical}`, 409);
    }
    reserved.add(canonical);
    entries.push({
      local,
      email: `${local}@${domain}`,
      name: local,
      password: randomPassword
        ? randomString(passwordLength, passwordGroups)
        : input.password,
    });
  }
  return entries;
}
