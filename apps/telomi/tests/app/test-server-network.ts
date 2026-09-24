import assert from "node:assert/strict";

import { isAllowedBrowserOrigin, resolveServerHost } from "../../server/config/network.js";

assert.equal(resolveServerHost({}), "127.0.0.1");
assert.equal(resolveServerHost({ TELOMI_HOST: "0.0.0.0" }), "0.0.0.0");
assert.equal(isAllowedBrowserOrigin(undefined, 8787), true);
assert.equal(isAllowedBrowserOrigin("http://localhost:5174", 8787), true);
assert.equal(isAllowedBrowserOrigin("http://127.0.0.1:8787", 8787), true);
assert.equal(isAllowedBrowserOrigin("http://localhost:5174", 8787, "not a url"), true);
assert.equal(isAllowedBrowserOrigin("https://telomi.example", 8787, "https://telomi.example/app"), true);
assert.equal(isAllowedBrowserOrigin("https://evil.example", 8787), false);
assert.equal(isAllowedBrowserOrigin("https://telomi.example", 8787, "not a url"), false);

console.log("Server network defaults test passed");
