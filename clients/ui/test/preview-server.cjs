// Local UI preview only. Serves the isolated bridge fixture, never real mail.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
http
  .createServer(async (req, res) => {
    try {
      const route = new URL(req.url, "http://localhost").pathname;
      const file =
        route === "/bridge.js"
          ? path.join(__dirname, "fixture.js")
          : path.resolve(root, "." + (route === "/" ? "/index.html" : route));
      if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
        }[path.extname(file)] || "application/octet-stream",
      );
      res.end(await fs.readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(0, "127.0.0.1", function () {
    console.log(
      "Preview: http://127.0.0.1:" + this.address().port + "/?android=1",
    );
  });
