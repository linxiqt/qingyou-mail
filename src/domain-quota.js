import { AppError } from "./security.js";

const maximumMailboxLimit = 1000000;

export function normalizeMailboxLimit(value, fallback = null) {
  const limit = value === undefined ? fallback : value;
  if (limit === null) return null;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > maximumMailboxLimit
  )
    throw new AppError("邮箱数量上限需为 0–1000000 的整数，或设为不限");
  return limit;
}

function capacityError(code, detail = "") {
  const error = new AppError(
    code === "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE"
      ? `邮箱数量上限不能小于当前已用数量${detail}`
      : `域名邮箱数量已达上限${detail}，请联系全局管理员调整配额`,
    409,
  );
  error.code = code;
  return error;
}

export function mailboxCapacity(db, domainId) {
  const row = db
    .prepare(
      "SELECT d.mailbox_limit,(SELECT count(*) FROM users u WHERE u.domain_id=d.id) AS mailbox_count FROM domains d WHERE d.id=? AND d.name<>''",
    )
    .get(domainId);
  if (!row) throw new AppError("域名不存在", 404);
  return {
    ...row,
    mailbox_remaining:
      row.mailbox_limit === null
        ? null
        : Math.max(0, row.mailbox_limit - row.mailbox_count),
  };
}

export function assertMailboxCapacity(db, domainId, count = 1) {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new AppError("新增邮箱数量无效");
  const domain = db
    .prepare("SELECT enabled FROM domains WHERE id=? AND name<>''")
    .get(domainId);
  if (!domain?.enabled) throw new AppError("域名不存在或已停用", 409);
  const capacity = mailboxCapacity(db, domainId);
  if (capacity.mailbox_limit !== null && count > capacity.mailbox_remaining)
    throw capacityError(
      "DOMAIN_MAILBOX_LIMIT",
      `（已用 ${capacity.mailbox_count} / ${capacity.mailbox_limit}，本次需 ${count} 个）`,
    );
  return capacity;
}

export function assertMailboxLimit(db, domainId, value) {
  const limit = normalizeMailboxLimit(value);
  const capacity = mailboxCapacity(db, domainId);
  if (limit !== null && limit < capacity.mailbox_count)
    throw capacityError(
      "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE",
      `（已用 ${capacity.mailbox_count} 个）`,
    );
  return limit;
}

// SQLite trigger errors deliberately carry a fixed token, never SQL or account
// data. Preserve existing application errors and translate only our own tokens.
export function quotaError(error) {
  if (
    error?.code?.startsWith("ERR_SQLITE") &&
    ["DOMAIN_MAILBOX_LIMIT", "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE"].includes(
      error.message,
    )
  )
    return capacityError(error.message);
  return error;
}
