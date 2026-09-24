import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevelopmentApiBase } from "../../scripts/voice-dev-api-base.js";

test("voice dev API base follows a custom API_PORT", () => {
	assert.equal(
		resolveDevelopmentApiBase({ API_PORT: "8813" }),
		"http://localhost:8813",
	);
});

test("voice dev API base preserves an explicit VITE_API_BASE", () => {
	assert.equal(
		resolveDevelopmentApiBase({
			API_PORT: "8813",
			VITE_API_BASE: " http://127.0.0.1:9900 ",
		}),
		"http://127.0.0.1:9900",
	);
});

test("voice dev API base retains the default backend port", () => {
	assert.equal(resolveDevelopmentApiBase({}), "http://localhost:8787");
});
