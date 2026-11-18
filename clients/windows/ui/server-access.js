// Mail permissions and commercial licensing are separate checks. Only a fresh
// authenticated server response populates these in-memory fields; never the vault.
export function normalizeLicense(value) {
  if (
    !value ||
    typeof value.required !== "boolean" ||
    typeof value.valid !== "boolean"
  )
    return null;
  const expiresAt = value.expiresAt;
  if (
    value.required &&
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
  )
    return null;
  return {
    required: value.required,
    valid: value.valid,
    expiresAt: expiresAt ?? null,
    mode: ["online", "offline", "blocked", "development", "none"].includes(value.mode)
      ? value.mode
      : "blocked",
    reason: typeof value.reason === "string" ? value.reason.slice(0, 300) : "",
  };
}
export const connected = (account) =>
  account?.connection === "connected" && !account.authExpired;
export function licensed(account, now = Date.now()) {
  const license = account?.license;
  if (connected(account) && license?.required === false) return license.valid === true;
  return (
    connected(account) &&
    license?.required === true &&
    license.valid === true &&
    (license.expiresAt === null ||
      (Number.isSafeInteger(license.expiresAt) &&
        license.expiresAt * 1000 > now))
  );
}
export const canRecoverLicense = (account) =>
  connected(account) &&
  account.portal === "admin" &&
  account.user?.role === "admin" &&
  account.user?.admin_scope === "global";
export function accessMessage(account) {
  if (!connected(account))
    return account?.connectionError || "请先连接服务端并验证登录。";
  if (!account.license)
    return "服务端没有返回可验证的授权状态，请更新服务端授权版后重试。";
  if (!account.license.required)
    return "服务端无需激活。";
  if (
    account.license.expiresAt !== null &&
    account.license.expiresAt * 1000 <= Date.now()
  )
    return "服务端授权已到期，请联系管理员续期。";
  if (!licensed(account))
    return (
      account.license.reason ||
      "服务端尚未激活或授权已失效，请联系管理员恢复授权。"
    );
  return account.license.mode === "offline"
    ? "服务端离线授权有效"
    : "服务端授权有效";
}
