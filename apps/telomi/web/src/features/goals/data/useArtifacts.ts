import { useMemo } from "react";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface ReactArtifact {
	filename: string;
	content: string;
	encoding: "utf-8" | "base64";
	createdAt: number;
	updatedAt: number;
}

interface ArtifactsArgs {
	command: "create" | "update" | "rewrite" | "get" | "delete" | "logs";
	filename: string;
	content?: string;
	encoding?: "utf-8" | "base64";
	old_str?: string;
	new_str?: string;
}

/**
 * Replay every `artifacts` tool call in message order to derive the current
 * artifacts state. HTML sandbox execution is delegated to SandboxedIframe at view time.
 */
export function useArtifacts(messages: AgentMessage[]): Map<string, ReactArtifact> {
	return useMemo(() => {
		const map = new Map<string, ReactArtifact>();
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			for (const block of msg.content) {
				if (block.type !== "toolCall" || block.name !== "artifacts") continue;
				const args = (block.arguments ?? {}) as ArtifactsArgs;
				const now = msg.timestamp ?? Date.now();
				const filename = args.filename;
				if (!filename) continue;
				const prev = map.get(filename);
				const encoding: "utf-8" | "base64" = args.encoding === "base64" ? "base64" : "utf-8";
				switch (args.command) {
					case "create":
					case "rewrite": {
						if (typeof args.content !== "string") break;
						map.set(filename, {
							filename,
							content: args.content,
							encoding,
							createdAt: prev?.createdAt ?? now,
							updatedAt: now,
						});
						break;
					}
					case "update": {
						if (!prev) break;
						if (prev.encoding === "base64") break;
						if (typeof args.old_str !== "string" || typeof args.new_str !== "string") break;
						if (!prev.content.includes(args.old_str)) break;
						map.set(filename, {
							...prev,
							content: prev.content.replace(args.old_str, args.new_str),
							updatedAt: now,
						});
						break;
					}
					case "delete": {
						map.delete(filename);
						break;
					}
				}
			}
		}
		return map;
	}, [messages]);
}
