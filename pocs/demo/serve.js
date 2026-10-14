// Static server for out/ with Range support (video seeking needs it; python's http.server has none).
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("./out/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".webm": "video/webm", ".vtt": "text/vtt", ".json": "application/json", ".zip": "application/zip" };
createServer((req, res) => {
  const file = join(ROOT, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
  let size;
  try { size = statSync(file).size; } catch { return res.writeHead(404).end(); }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Number(m[2]) : size - 1;
  res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}).listen(Number(process.argv[2] ?? 7101), () => console.log("serving out/ on", process.argv[2] ?? 7101));
