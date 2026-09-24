/**
 * Dump the REAL, post-hook-chain system prompt that the main session agent
 * actually receives, including every `before_agent_start` hook injection.
 *
 * Why this is non-trivial:
 *   The base prompt (global base + Main Agent prompt + SDK-added current
 *   date/cwd) is only half the story. Extensions mutate the prompt every turn
 *   via the `before_agent_start` hook chain (agent-session.js:777). To see what
 *   the LLM really sees, we have to real-launch a GoalRunner so the SDK loads
 *   extensions, builds the ExtensionRunner, and lets us replay that hook chain.
 *
 * Flow:
 *   1. Bootstrap a real Goal-local Harness layout.
 *   2. new GoalRunner(...) + await init(). init() awaits resourceLoader.reload()
 *      so all extensions' `before_agent_start` registrations
 *      have run by the time it returns. AgentSession's constructor also rebuilds
 *      the base system prompt, so agent.state.systemPrompt now == _baseSystemPrompt.
 *   3. await bindExtensions() so session_start fires (some extensions defer
 *      setup until then, and uiContext/runtime bindings get wired up).
 *   4. Prepare the same immutable Main Workspace used by a real turn and
 *      rebuild the Prompt so product and Goal Skills are mounted.
 *   5. Manually call extensionRunner.emitBeforeAgentStart(...) with a dummy
 *      prompt to replay the exact mutation chain agent-session.js:777 runs on
 *      every turn. Apply result.systemPrompt to get the final prompt.
 *   6. dispose() to fire session_shutdown and release session resources.
 *
 * Run: npx tsx scripts/dump-system-prompt.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "../server/config/data-dir.js";
import { ensureGoalWorkspace } from "../server/workspaces/goal-project.js";
import { GoalRunner } from "../server/main-agent/runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const workspaceDir = resolveDataDir();

const description = "示例 goal - 用于 dump 主 session agent 的真实系统提示词";

mkdirSync(workspaceDir, { recursive: true });
process.env.TELOMI_DATA_DIR = workspaceDir;

const goalId = `goal_dump_${Date.now().toString(36)}`;
const goalDir = join(workspaceDir, goalId);

// 1. Bootstrap the same Goal-local Harness layout used by GoalService.
ensureGoalWorkspace({
	goalDir,
	goalId,
	title: "system-prompt-dump",
	description,
	createdAt: new Date().toISOString(),
});

async function main(): Promise<void> {
	// 2. Real-launch the runner with the same constructor args GoalService passes.
	const runner = new GoalRunner(
		workspaceDir,
		goalId,
		"system-prompt-dump",
		goalDir,
		() => undefined, // onSnapshot noop because this script does not render UI
		description,
	);

	// init() awaits resourceLoader.reload() so all extensions are loaded and
	// their handler maps populated. AgentSession's constructor also runs
	// _refreshToolRegistry → _rebuildSystemPrompt, so agent.state.systemPrompt
	// holds _baseSystemPrompt by the time this resolves.
	await runner.init();

	// bindExtensions fires session_start so deferred session setup comes online.
	// Some hooks only finish wiring their state machine here, and
	// before_agent_start handlers may reference that state.
	await runner.bindExtensions();

	// 4. Reach into the runner's private fields. Module-private to GoalRunner,
	// but we control both sides. This is intentional inspection.
	const session = (runner as unknown as { session: any }).session;
	const agent = (runner as unknown as { agent: any }).agent;
	const workspaceRuntime = (runner as unknown as { mainWorkspaceRuntime: any }).mainWorkspaceRuntime;
	const workspaceSession = workspaceRuntime.prepare({ conversationId: goalId });
	(runner as unknown as { activeMainWorkspaceSession?: unknown }).activeMainWorkspaceSession = workspaceSession;
	session.setActiveToolsByName(session.getActiveToolNames());

	const basePrompt: string = agent.state.systemPrompt;

	// 4. Replay the hook chain that agent-session.js:777 fires on every
	// session.prompt(...). systemPromptOptions is undefined for this inspection.
	const hookResult = await session.extensionRunner.emitBeforeAgentStart(
		"[dump-system-prompt] dummy user prompt",
		undefined,
		basePrompt,
		undefined,
	);

	const finalPrompt: string = hookResult?.systemPrompt ?? basePrompt;
	const hookAddedChars = finalPrompt.length - basePrompt.length;

	// 5. Snapshot which extensions actually injected into the prompt so the
	// reader can correlate the diff back to source extensions. We diff
	// section-by-section by running each extension in isolation against the
	// SAME basePrompt. This approximates each extension's contribution even
	// though, in production, they run sequentially and a later extension's
	// "input" is the previous extension's output.
	const extensionsList = session.extensionRunner.extensions as Array<{
		path: string;
		handlers: Map<string, Array<(event: any, ctx: any) => Promise<any>>>;
	}>;
	const perExtensionContrib: Array<{ path: string; addedChars: number; hasHandler: boolean }> = [];
	for (const ext of extensionsList) {
		const handlers = ext.handlers.get("before_agent_start") ?? [];
		if (handlers.length === 0) {
			perExtensionContrib.push({ path: ext.path, addedChars: 0, hasHandler: false });
			continue;
		}
		let current = basePrompt;
		const ctx = (session.extensionRunner as any).createContext();
		ctx.getSystemPrompt = () => current;
		for (const handler of handlers) {
			try {
				const r = await handler(
					{
						type: "before_agent_start",
						prompt: "[dump]",
						images: undefined,
						systemPrompt: current,
						systemPromptOptions: undefined,
					},
					ctx,
				);
				if (r?.systemPrompt !== undefined) current = r.systemPrompt;
			} catch {
				/* Per-extension probe: keep inspecting remaining extensions. */
			}
		}
		perExtensionContrib.push({
			path: ext.path,
			addedChars: current.length - basePrompt.length,
			hasHandler: true,
		});
	}

	// 6. Clean the inspection workspace and dispose so timers can stop.
	await workspaceRuntime.abort(workspaceSession.id);
	runner.dispose();

	// 7. Write the dump.
	const outPath = join(projectRoot, `system-prompt-dump-real-${goalId}.md`);
	const md = [
		"# Main Session System Prompt - Real Post-Hook Dump",
		"",
		`- **Goal ID**: \`${goalId}\``,
		`- **Goal Dir**: \`${goalDir}\``,
		`- **Workspace**: \`${workspaceDir}\``,
		"- **Sandbox**: `srt`",
		`- **Description**: ${description}`,
		`- **Generated At**: ${new Date().toISOString()}`,
		`- **Base Prompt Length**: ${basePrompt.length} chars (from ResourceLoader chain)`,
		`- **Final Prompt Length**: ${finalPrompt.length} chars (after \`before_agent_start\` hook chain)`,
		`- **Hook-Chain Delta**: +${hookAddedChars} chars`,
		`- **Extensions Loaded**: ${extensionsList.length}`,
		"",
		"## Composition",
		"",
		"1. Project global base (`agents/main/global-base/prompts/system.md.njk`)",
		"2. Main Agent routing prompt (`agents/main/router/prompts/system.md.njk`)",
		"3. SDK-added Skill Pool and current working directory (Pi >= 0.80.7 no longer injects the date; the router prompt tells the Agent to run `date`)",
		"4. `before_agent_start` hook chain",
		"",
		"## Per-Extension Contribution (probed in isolation against base prompt)",
		"",
		"| Extension | Has `before_agent_start` | Added chars (isolated) |",
		"|---|---|---|",
		...perExtensionContrib.map((e) => {
			const name = e.path.split("/").slice(-2).join("/");
			return `| \`${name}\` | ${e.hasHandler ? "yes" : "no"} | ${e.hasHandler ? `+${e.addedChars}` : "0"} |`;
		}),
		"",
		"> Note: isolated contributions are an approximation. In production, hooks run sequentially and each sees the previous extension's output. The Final Prompt below is the real sequential result.",
		"",
		"---",
		"",
		"## Final System Prompt (post hook chain - what the LLM actually receives)",
		"",
		"```text",
		finalPrompt,
		"```",
		"",
		"---",
		"",
		"## Base Prompt (pre hook chain - what ResourceLoader produced)",
		"",
		"```text",
		basePrompt,
		"```",
		"",
	].join("\n");

	writeFileSync(outPath, md, "utf-8");

	console.log(`✅ Real post-hook system prompt dump written to:`);
	console.log(`   ${outPath}`);
	console.log(``);
	console.log(`📁 Goal directory:    ${goalDir}`);
	console.log(`📏 Base prompt:       ${basePrompt.length} chars`);
	console.log(`📏 Final prompt:      ${finalPrompt.length} chars (+${hookAddedChars} from hook chain)`);
	console.log(`🧩 Extensions loaded: ${extensionsList.length}`);
	for (const e of perExtensionContrib) {
		if (!e.hasHandler) continue;
		const name = e.path.split("/").slice(-2).join("/");
		console.log(`   • ${name}: +${e.addedChars} chars`);
	}

	// dispose() is fire-and-forget, so force-exit after the dump is written.
	process.exit(0);
}

main().catch((err) => {
	console.error("❌ Dump failed:", err);
	process.exit(1);
});
