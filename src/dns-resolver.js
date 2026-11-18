import { Resolver } from "node:dns/promises";

export function dnsJsonAnswers(packet, type) {
  if (packet.Status !== 0)
    throw Object.assign(new Error("DNS response error"), {
      code: packet.Status === 3 ? "ENOTFOUND" : "ESERVFAIL",
    });
  const types = { A: 1, AAAA: 28, MX: 15, TXT: 16 };
  return (packet.Answer || [])
    .filter((x) => x.type === types[type])
    .map(({ data }) => {
      if (type === "MX") {
        const [priority, exchange] = data.trim().split(/\s+/);
        return { priority: Number(priority), exchange };
      }
      if (type !== "TXT") return data;
      const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
        m[1].replace(/\\(\d{3}|.)/g, (_all, value) =>
          /^\d{3}$/.test(value) ? String.fromCharCode(Number(value)) : value,
        ),
      );
      return parts.length ? parts : [data];
    });
}
export function createDnsResolver(
  config = {},
  native = new Resolver({ timeout: 1800, tries: 1 }),
  fetcher = fetch,
) {
  const endpoint = config.dnsDohUrl || "https://dns.alidns.com/resolve";
  const resolver = {
    fallbackUsed: false,
    provider: new URL(endpoint).hostname,
    cancel: () => native.cancel?.(),
  };
  for (const [method, type] of [
    ["resolve4", "A"],
    ["resolve6", "AAAA"],
    ["resolveMx", "MX"],
    ["resolveTxt", "TXT"],
  ]) {
    resolver[method] = async (name) => {
      try {
        return await native[method](name);
      } catch (error) {
        if (
          config.dnsDohFallback === false ||
          ["ENODATA", "ENOTFOUND"].includes(error.code)
        )
          throw error;
        resolver.fallbackUsed = true;
        const url = new URL(endpoint);
        url.searchParams.set("name", name);
        url.searchParams.set("type", type);
        url.searchParams.set("edns_client_subnet", "0.0.0.0/0");
        try {
          const response = await fetcher(url, {
            headers: { Accept: "application/dns-json" },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok)
            throw Object.assign(new Error("DNS HTTPS unavailable"), {
              code: `DOH_HTTP_${response.status}`,
            });
          return dnsJsonAnswers(await response.json(), type);
        } catch (failure) {
          if (failure.name === "TimeoutError" || failure.name === "AbortError")
            throw Object.assign(new Error("DNS HTTPS timeout"), {
              code: "ETIMEOUT",
            });
          throw failure;
        }
      }
    };
  }
  return resolver;
}
