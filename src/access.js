import { AppError } from "./security.js";
import { effectiveCapabilities } from "./admin-permissions.js";

export const isGlobalAdmin = (user) =>
  user?.role === "admin" && user.admin_scope !== "scoped";
export const isClientManager = (user) =>
  user?.role === "user" && user.client_manager === 1;
export const canManageDomains = (user) =>
  user?.role === "admin" || isClientManager(user);
export function requireGlobal(user) {
  if (!isGlobalAdmin(user)) throw new AppError("此操作需要全局管理员权限", 403);
}
export function domainIds(db, user, operation = "read") {
  if (isGlobalAdmin(user)) return null;
  if (!canManageDomains(user)) return [];
  if (!["read", "create", "update", "delete"].includes(operation))
    throw new Error("Unknown permission");
  return db
    .prepare(
      `SELECT domain_id FROM domain_permissions WHERE user_id=? AND can_${operation}=1`,
    )
    .all(user.id)
    .map((row) => row.domain_id);
}
export function requireDomain(db, user, id, operation = "read") {
  const allowed = domainIds(db, user, operation);
  if (allowed !== null && !allowed.includes(Number(id)))
    throw new AppError("没有该域名的操作权限", 403);
}
export function scopeSql(db, user, column, operation = "read") {
  const allowed = domainIds(db, user, operation);
  return allowed === null
    ? { sql: "1=1", args: [] }
    : allowed.length
      ? {
          sql: `${column} IN (${allowed.map(() => "?").join(",")})`,
          args: allowed,
        }
      : { sql: "0=1", args: [] };
}
export function userPayload(db, user) {
  return {
    management_only: !user.email.includes("@"),
    client_manager: isClientManager(user),
    admin_scope: user.admin_scope || "global",
    role_preset: user.admin_role || "legacy",
    capabilities: effectiveCapabilities(user),
    avatar: user.avatar || "",
    note: user.note || "",
    permissions:
      (user.role === "admin" && user.admin_scope === "scoped") ||
      isClientManager(user)
        ? db
            .prepare(
              "SELECT p.*,d.name AS domain FROM domain_permissions p JOIN domains d ON d.id=p.domain_id WHERE user_id=?",
            )
            .all(user.id)
        : [],
  };
}
