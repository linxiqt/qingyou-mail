import { AppError } from "./security.js";

// Resolve catch-all edges only for addresses that have never been registered.
// Disabled and expired mailboxes must not fall through to a domain-wide rule.
export function assertForwardGraph(db) {
  const users = new Map(
    db
      .prepare("SELECT id,email FROM users")
      .all()
      .map((u) => [u.email, u.id]),
  );
  const edges = new Map();
  for (const row of db
    .prepare(
      "SELECT u.email,f.target FROM forwards f JOIN users u ON u.id=f.user_id WHERE f.enabled=1",
    )
    .all()) {
    if (!edges.has(row.email)) edges.set(row.email, []);
    edges.get(row.email).push(row.target);
  }
  const domains = new Map(
    db
      .prepare(
        "SELECT d.name,f.target FROM catchall_forwards f JOIN domains d ON d.id=f.domain_id WHERE f.enabled=1",
      )
      .all()
      .map((r) => [r.name, r.target]),
  );
  for (const row of db
    .prepare(
      "SELECT d.name,u.email FROM domain_catchalls c JOIN domains d ON d.id=c.domain_id JOIN users u ON u.id=c.user_id WHERE c.enabled=1",
    )
    .all())
    if (!domains.has(row.name)) domains.set(row.name, row.email);
  function visit(address, path = new Set()) {
    const key = users.has(address)
      ? address
      : domains.has(address.split("@")[1])
        ? `*@${address.split("@")[1]}`
        : address;
    if (path.has(key) || path.size > 10)
      throw new AppError("转发规则存在循环或链路过长");
    const targets = users.has(address)
      ? edges.get(address) || []
      : domains.has(address.split("@")[1])
        ? [domains.get(address.split("@")[1])]
        : [];
    for (const target of targets) visit(target, new Set([...path, key]));
  }
  for (const email of edges.keys()) visit(email);
  for (const [name, target] of domains) visit(target, new Set([`*@${name}`]));
}
