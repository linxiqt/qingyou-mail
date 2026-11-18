import { createHash } from "node:crypto";
import { AppError, makeWindowLimiter, verifyPassword } from "./security.js";
import { isClientManager } from "./access.js";
import { requireCapability } from "./admin-permissions.js";

const refused = () => new AppError("Mailbox authentication failed", 401, 535);

// A protocol session is bound to the credential that was actually verified.
// A password reset, deleted/recreated account or disabled domain invalidates it.
const principal = (user) =>
  user.id +
  "." +
  createHash("sha256")
    .update(user.email)
    .update("\0")
    .update(user.password_hash)
    .digest("base64url");

export function createMailProtocolAuth(store, mail) {
  const limit = makeWindowLimiter(30, 15 * 60000);
  const lookup = store.db.prepare(
    "SELECT id, email, password_hash FROM users WHERE email=?",
  );
  function authorize(identity, capability) {
    const user = mail.activeUser(
      Number(String(identity).split(".", 1)[0]) || 0,
    );
    if (!user?.email.includes("@") || principal(user) !== identity)
      throw refused();
    if (
      capability &&
      (isClientManager(user) ||
        (user.role === "admin" && user.admin_scope === "scoped"))
    )
      requireCapability(user, capability);
    return user;
  }
  async function authenticate(
    username,
    password,
    remote,
    capability,
    allowedMailbox,
  ) {
    limit(String(remote || "unknown").replace(/^::ffff:/, ""));
    const email = String(username).trim().toLowerCase();
    const user =
      allowedMailbox === undefined || email === allowedMailbox
        ? lookup.get(email)
        : undefined;
    if (!(await verifyPassword(password, user?.password_hash)) || !user)
      throw refused();
    const identity = principal(user);
    authorize(identity, capability);
    return identity;
  }
  return { authenticate, authorize };
}
