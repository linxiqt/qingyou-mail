import { parentPort, workerData } from "node:worker_threads";
const rules = workerData.rules.map((rule) => ({
  ...rule,
  regex: new RegExp(rule.pattern, rule.flags),
}));
const result = workerData.messages.map((message) => {
  const details = [];
  let first = null;
  for (const rule of rules) {
    const base = {
      rule_id: rule.id,
      rule_name: rule.name,
      enabled: rule.enabled !== 0,
      matched: false,
      code: null,
      full_match: null,
    };
    if (
      rule.sender_filter &&
      !String(message.from_email || "")
        .toLowerCase()
        .includes(rule.sender_filter.toLowerCase())
    ) {
      if (workerData.detailed) details.push(base);
      continue;
    }
    if (
      rule.subject_filter &&
      !String(message.subject || "")
        .toLowerCase()
        .includes(rule.subject_filter.toLowerCase())
    ) {
      if (workerData.detailed) details.push(base);
      continue;
    }
    rule.regex.lastIndex = 0;
    const match = rule.regex.exec(
      `${message.subject || ""}\n${message.body_text || ""}`.slice(0, 20000),
    );
    const code = String(match?.[1] || match?.[0] || "").trim();
    const valid = code && code.length <= 128 && !/[\r\n\0]/.test(code);
    if (workerData.detailed) {
      details.push({
        ...base,
        matched: Boolean(match),
        code: valid ? code : null,
        full_match: match?.[0]?.slice(0, 1000) || null,
      });
      if (valid && rule.enabled !== 0 && !first)
        first = { code, rule_id: rule.id, rule_name: rule.name };
    } else if (valid) return { code, rule_id: rule.id, rule_name: rule.name };
  }
  if (workerData.detailed)
    return {
      ...(first || { code: null, rule_id: null, rule_name: null }),
      results: details,
    };
  return { code: null, rule_id: null, rule_name: null };
});
parentPort.postMessage(result);
