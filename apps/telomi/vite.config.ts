import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveDevelopmentApiBase } from "./scripts/voice-dev-api-base.js";
import { loadProjectEnvironment } from "./server/config/environment.js";

const inlineTreeShakenPackages = new Set([
	"d3-format",
	"d3-time",
	"d3-time-format",
	"detect-node-es",
	"html-parse-stringify",
	"micromark-extension-gfm-tagfilter",
	"micromark-util-encode",
	"motion",
	"void-elements",
]);

export default defineConfig(({ command }) => {
	loadProjectEnvironment(__dirname);
	const apiPort = process.env.API_PORT?.trim() || "8787";
	// The same host the server binds; "localhost" may resolve to ::1, which the server never listens on.
	const apiHost = process.env.TELOMI_HOST?.trim() || "127.0.0.1";
	return {
		root: "web",
		plugins: [tailwindcss(), react({ include: /\.(tsx|jsx)$/ })],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "web/src"),
				"@shared": path.resolve(__dirname, "shared"),
			},
		},
		...(command === "serve"
			? {
					define: {
						"import.meta.env.VITE_API_BASE": JSON.stringify(
							resolveDevelopmentApiBase(process.env),
						),
					},
				}
			: {}),
		server: {
			host: "127.0.0.1",
			port: Number(process.env.WEB_PORT || "5174"),
			strictPort: true,
			proxy: {
				"/api": {
					target: `http://${apiHost}:${apiPort}`,
					ws: true,
				},
			},
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
			// The only intentionally large chunks are lazily loaded diagram engines and
			// optional Shiki grammars. The interactive entry chunk remains below 500 kB.
			chunkSizeWarningLimit: 1_500,
			rollupOptions: {
				output: {
					manualChunks(id) {
						const marker = "/node_modules/";
						const index = id.lastIndexOf(marker);
						if (index < 0) return undefined;
						const parts = id.slice(index + marker.length).split("/");
						const packageName = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
						if (
							!packageName ||
							packageName === "shiki" ||
							packageName.startsWith("@shikijs/") ||
							inlineTreeShakenPackages.has(packageName)
						) return undefined;
						return `vendor-${packageName.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
					},
				},
			},
		},
		optimizeDeps: {
			include: ["beautiful-mermaid"],
		},
	};
});
