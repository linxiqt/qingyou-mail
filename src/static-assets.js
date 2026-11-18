import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";

// Only public code/styles are cached and compressed. Authenticated responses,
// email, attachments and HTML never enter this shared cache.
export async function createAssetHandler(directory) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const assets = new Map();
  const types = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  await Promise.all(
    (await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const ext = path.extname(entry.name);
      if (!entry.isFile() || !types[ext]) return;
      const identity = await readFile(path.join(directory, entry.name));
      const [br, gz] = await Promise.all([
        promisify(brotliCompress)(identity, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        }),
        promisify(gzip)(identity, { level: 6 }),
      ]);
      const variants = Object.fromEntries(
        Object.entries({ identity, br, gzip: gz }).map(([encoding, data]) => [
          encoding,
          {
            data,
            etag:
              '"' + createHash("sha256").update(data).digest("base64url") + '"',
          },
        ]),
      );
      assets.set("/" + entry.name, { type: types[ext], variants });
    }),
  );
  return (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) return next();
    const asset = assets.get(req.path);
    if (!asset) return next();
    const encoding = req.acceptsEncodings("br", "gzip", "identity");
    if (!encoding) return res.status(406).end();
    const { data, etag } = asset.variants[encoding];
    res.set({
      "Content-Type": asset.type,
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: etag,
      "Content-Length": String(data.length),
    });
    res.vary("Accept-Encoding");
    if (encoding !== "identity") res.set("Content-Encoding", encoding);
    if (req.fresh) return res.status(304).end();
    return req.method === "HEAD" ? res.end() : res.end(data);
  };
}
