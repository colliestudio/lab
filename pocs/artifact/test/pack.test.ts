import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { packViewerJs } from "../src/server/build.ts";

test("build: viewer JS ships gzipped + base64 behind a small loader module", () => {
  const js = "console.log('</div>'.repeat(100))";
  const html = `<head><!--RECAP_BOOT--><script type="module" crossorigin>${js}</script><style>a{}</style></head>`;
  const out = packViewerJs(html);
  const b64 = /<script type="application\/gzip;base64" id="recap-js">([A-Za-z0-9+/=]+)<\/script>/.exec(out)![1];
  assert.equal(gunzipSync(Buffer.from(b64, "base64")).toString(), js);
  assert.ok(!out.includes(js), "plain JS removed");
  assert.match(out, /<script type="module">[^<]*DecompressionStream\("gzip"\)[^<]*<\/script><style>/);
  assert.ok(out.indexOf("<!--RECAP_BOOT-->") < out.indexOf('<script type="module"'), "boot marker stays before the module");
  assert.equal(packViewerJs("<p>no script</p>"), "<p>no script</p>");
});
