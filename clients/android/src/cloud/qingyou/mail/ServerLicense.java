package cloud.qingyou.mail;

import org.json.JSONObject;

/** Server-issued authorization only. Never activate a separate device license. */
final class ServerLicense {
  static boolean requires(String path) {
    return path.matches("(?i)^/(send|drafts|manage)(/.*|\\?.*|)$");
  }
  static boolean valid(JSONObject body, long nowMillis) {
    if (body.optJSONObject("user") == null) return false;
    JSONObject license = body.optJSONObject("license");
    if (license != null && Boolean.FALSE.equals(license.opt("required"))) return Boolean.TRUE.equals(license.opt("valid"));
    if (license == null || !Boolean.TRUE.equals(license.opt("required")) || !Boolean.TRUE.equals(license.opt("valid")) || !license.has("expiresAt")) return false;
    if (license.isNull("expiresAt")) return true;
    Object expires = license.opt("expiresAt");
    if (!(expires instanceof Number)) return false;
    double seconds = ((Number)expires).doubleValue();
    return !Double.isNaN(seconds) && !Double.isInfinite(seconds) && seconds == Math.floor(seconds) && seconds <= 9007199254740991D && seconds > nowMillis / 1000D;
  }
  private ServerLicense() { }
}
