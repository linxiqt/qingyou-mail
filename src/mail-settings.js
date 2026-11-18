import { domainName } from "./security.js";
import { getSetting, putSetting } from "./settings.js";

export function mailHostnameConfigured(config) {
  return !["", "localhost"].includes(config.mailHostname);
}

export function loadMailSettings(db, config) {
  const saved = getSetting(db, "mail-server");
  if (saved.hostname) config.mailHostname = domainName(saved.hostname);
}

export function saveMailHostname(db, config, value) {
  const hostname = domainName(value);
  putSetting(db, "mail-server", { hostname });
  config.mailHostname = hostname;
  return { hostname, configured: true };
}

export function configureFirstMailDomain(db, config, domain) {
  if (!mailHostnameConfigured(config))
    saveMailHostname(
      db,
      config,
      domain.length <= 248 ? `mail.${domain}` : domain,
    );
}
