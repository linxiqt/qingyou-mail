import { AppError, emailAddress, recipients } from "./security.js";
import { integer, domainList, ipRules } from "./settings.js";

export function sendPolicy(input = {}, old = {}) {
  const source = { ...old, ...input };
  const allowedSenders =
    source.allowedSenders === undefined
      ? []
      : recipients(source.allowedSenders);
  const defaultSender = source.defaultSender
    ? emailAddress(source.defaultSender)
    : "";
  if (
    defaultSender &&
    allowedSenders.length &&
    !allowedSenders.includes(defaultSender)
  )
    throw new AppError("默认发件邮箱需在允许发件人列表内");
  return {
    defaultSender,
    allowedSenders,
    allowedRecipientDomains: domainList(source.allowedRecipientDomains),
    dailyLimit: integer(source.dailyLimit, 0, 0, 100000, "每日发送额度"),
    ipAllowlist: ipRules(source.ipAllowlist || "").text,
  };
}
export function checkSendPolicy(store, key, ip, input, fallbackSender) {
  const policy = sendPolicy(JSON.parse(key.policy_json || "{}"));
  if (!ipRules(policy.ipAllowlist).test(ip))
    throw new AppError("当前IP不在API白名单内", 403);
  const from = emailAddress(
    input.from || policy.defaultSender || fallbackSender,
  );
  if (policy.allowedSenders.length && !policy.allowedSenders.includes(from))
    throw new AppError("API不允许使用此发件邮箱", 403);
  const all = [
    ...new Set([
      ...recipients(input.to),
      ...recipients(input.cc),
      ...recipients(input.bcc),
    ]),
  ];
  if (!all.length) throw new AppError("请填写收件人");
  if (
    policy.allowedRecipientDomains.length &&
    all.some((e) => !policy.allowedRecipientDomains.includes(e.split("@")[1]))
  )
    throw new AppError("收件域名不在API允许范围内", 403);
  const day = new Date().toISOString().slice(0, 10),
    count = all.length;
  store.transaction(() => {
    const used =
      store.db
        .prepare(
          "SELECT count FROM api_daily_usage WHERE api_key_id=? AND day=?",
        )
        .get(key.id, day)?.count || 0;
    if (policy.dailyLimit && used + count > policy.dailyLimit)
      throw new AppError("API当日发送额度已用完", 429);
    store.db
      .prepare(
        "INSERT INTO api_daily_usage(api_key_id,day,count) VALUES(?,?,?) ON CONFLICT(api_key_id,day) DO UPDATE SET count=count+excluded.count",
      )
      .run(key.id, day, count);
  });
  return {
    from,
    refund() {
      store.db
        .prepare(
          "UPDATE api_daily_usage SET count=max(0,count-?) WHERE api_key_id=? AND day=?",
        )
        .run(count, key.id, day);
    },
  };
}
