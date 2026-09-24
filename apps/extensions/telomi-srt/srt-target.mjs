import { spawn } from "node:child_process";

const value = process.env.TELOMI_SRT_TARGET_B64;
if (!value) throw new Error("TELOMI_SRT_TARGET_B64 is required");
const target = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
delete process.env.TELOMI_SRT_TARGET_B64;

const env = { ...target.env };
for (const [name, value] of Object.entries(process.env)) {
	if (value !== undefined && isSrtEnv(name)) env[name] = value;
}

const child = spawn(target.command, target.args, {
	env,
	detached: true,
	stdio: "inherit",
});
const terminate = () => {
	if (!child.pid) return;
	try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
};
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
const result = await new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
});
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.code;

function isSrtEnv(name) {
	return /_proxy$/iu.test(name)
		|| [
			"SANDBOX_RUNTIME",
			"NODE_EXTRA_CA_CERTS",
			"SSL_CERT_FILE",
			"CURL_CA_BUNDLE",
			"REQUESTS_CA_BUNDLE",
			"PIP_CERT",
			"GIT_SSL_CAINFO",
			"AWS_CA_BUNDLE",
			"CARGO_HTTP_CAINFO",
			"DENO_CERT",
			"CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
			"NIX_SSL_CERT_FILE",
			"GIT_CONFIG_PARAMETERS",
			"GIT_SSH_COMMAND",
		].includes(name);
}
