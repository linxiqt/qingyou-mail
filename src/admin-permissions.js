import { AppError } from "./security.js";

export const capabilityCatalog = [
  ["accounts.read", "查看邮箱账号", "邮箱账号"],
  ["accounts.create", "创建与批量导入", "邮箱账号"],
  ["accounts.update", "编辑与停用账号", "邮箱账号"],
  ["accounts.password", "重置邮箱密码", "邮箱账号"],
  ["accounts.delete", "删除邮箱及邮件", "邮箱账号"],
  ["domains.read", "查看域名及 DNS", "域名"],
  ["domains.update", "编辑域名与全域捕获", "域名"],
  ["domains.delete", "删除域名", "域名"],
  ["mail.read", "读取邮件及附件", "邮件"],
  ["mail.send", "代发邮件与群发", "邮件"],
  ["mail.update", "标记、归档与恢复邮件", "邮件"],
  ["mail.delete", "移入垃圾箱与永久删除", "邮件"],
  ["forwards.read", "查看转发规则", "邮件转发"],
  ["forwards.write", "维护转发规则", "邮件转发"],
  ["templates.manage", "使用与管理个人模板", "邮件模板"],
].map(([id, name, group]) => ({ id, name, group }));
export const capabilityIds = capabilityCatalog.map((item) => item.id);
export const clientCapabilityIds = capabilityIds.filter(
  (id) => !["domains.update", "domains.delete"].includes(id),
);
export const rolePresets = [
  {
    id: "client_manager",
    name: "客户端域名用户",
    description: "仅在客户端管理明确分配域名的邮箱和邮件",
    capabilities: clientCapabilityIds,
  },
  {
    id: "domain_admin",
    name: "域名管理员",
    description: "管理被分配域名的邮箱、邮件和域名设置",
    capabilities: capabilityIds,
  },
  {
    id: "operator",
    name: "运营管理员",
    description: "维护邮箱和收发邮件，无删除账号、邮件或域名权限",
    capabilities: capabilityIds.filter(
      (id) =>
        ![
          "accounts.delete",
          "domains.update",
          "domains.delete",
          "mail.delete",
        ].includes(id),
    ),
  },
  {
    id: "auditor",
    name: "只读审计员",
    description: "查看被授权域名的邮箱、邮件与规则",
    capabilities: [
      "accounts.read",
      "domains.read",
      "mail.read",
      "forwards.read",
    ],
  },
  {
    id: "custom",
    name: "自定义权限",
    description: "逐项选择允许执行的操作",
    capabilities: [],
  },
];
export function effectiveCapabilities(user) {
  const client = user?.role === "user" && user.client_manager === 1;
  if (user?.role !== "admin" && !client) return [];
  const allowed = client ? clientCapabilityIds : capabilityIds;
  if (!client && user.admin_scope !== "scoped") return [...allowed];
  if (user.admin_capabilities == null) return client ? [] : [...allowed];
  try {
    const parsed = JSON.parse(user.admin_capabilities);
    return Array.isArray(parsed)
      ? allowed.filter((id) => parsed.includes(id))
      : [];
  } catch {
    return [];
  }
}
export function requireCapability(user, capability) {
  if (!effectiveCapabilities(user).includes(capability))
    throw new AppError("没有此功能的操作权限", 403);
}
export function managerCapabilities(body, old) {
  const preset =
    body.rolePreset ??
    (body.capabilities !== undefined
      ? "custom"
      : (old?.admin_role ?? "domain_admin"));
  if (
    preset === "legacy" &&
    old?.admin_role === "legacy" &&
    body.capabilities === undefined &&
    body.rolePreset === undefined
  )
    return { preset, capabilities: effectiveCapabilities(old) };
  const definition = rolePresets.find((role) => role.id === preset);
  if (!definition) throw new AppError("管理员权限模板无效");
  const capabilities =
    body.capabilities ??
    (body.rolePreset !== undefined
      ? definition.capabilities
      : old?.admin_capabilities != null
        ? effectiveCapabilities(old)
        : definition.capabilities);
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > capabilityIds.length ||
    capabilities.some(
      (id) => typeof id !== "string" || !capabilityIds.includes(id),
    ) ||
    new Set(capabilities).size !== capabilities.length
  )
    throw new AppError("功能权限配置无效");
  const selected = capabilityIds.filter((id) => capabilities.includes(id));
  return {
    preset:
      selected.join(",") ===
      capabilityIds
        .filter((id) => definition.capabilities.includes(id))
        .join(",")
        ? preset
        : "custom",
    capabilities: selected,
  };
}
