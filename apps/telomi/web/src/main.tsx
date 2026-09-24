import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import { App } from "@/app/App";
import { loadToolIconManifest } from "@/shared/lib/tool-icons";
import { initTheme } from "@/shared/lib/theme";
import "@/app/i18n";
import "./theme.css";
import "@/app/app.css";

initTheme();

void loadToolIconManifest().catch(() => {
	// Manifest fetch is best-effort; turn cards fall back to generic Bash icon.
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found in index.html");

createRoot(rootEl).render(
	<StrictMode>
		<LucideProvider strokeWidth={1.75}>
			<App />
		</LucideProvider>
	</StrictMode>,
);
