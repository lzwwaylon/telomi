import assert from "node:assert/strict";

class FakeEventSource {
	static readonly CLOSED = 2;
	static readonly instances: FakeEventSource[] = [];

	readonly url: string;
	readyState = 1;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent<string>) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor(url: string | URL) {
		this.url = String(url);
		FakeEventSource.instances.push(this);
	}

	close(): void {
		this.closed = true;
		this.readyState = FakeEventSource.CLOSED;
	}

	emit(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
	}
}

const fakeWindow = new EventTarget();
Object.assign(globalThis, { EventSource: FakeEventSource, window: fakeWindow });

const {
	subscribeGoalSessionEvents,
	subscribeGoalEvents,
	subscribeGoalsEvents,
	subscribeWikiEvents,
} = await import("../../web/src/shared/lib/goalsEventsStream.js");
const { subscribeActivityProjectionChanges } = await import("../../web/src/features/goals/data/useActivityProjection.js");
const { subscribeProviderAccountsEvents } = await import("../../web/src/shared/lib/providerAccountsStream.js");

const firstEvents: unknown[] = [];
const scopedEvents: unknown[] = [];
const wikiEvents: unknown[] = [];
const sessionStates: unknown[] = [];
const accountStates: unknown[] = [];
let goalActivityChanges = 0;
let globalActivityChanges = 0;
const unsubscribeFirst = subscribeGoalsEvents((event) => firstEvents.push(event));
const unsubscribeScoped = subscribeGoalEvents("goal_shared", (event) => scopedEvents.push(event));
const unsubscribeActivity = subscribeActivityProjectionChanges({
	goalId: "goal_shared",
	onChange: () => { goalActivityChanges += 1; },
	onConnectionChange: () => undefined,
});
const unsubscribeGlobalActivity = subscribeActivityProjectionChanges({
	onChange: () => { globalActivityChanges += 1; },
	onConnectionChange: () => undefined,
});
const unsubscribeWiki = subscribeWikiEvents("goal_shared", (event) => wikiEvents.push(event));
const unsubscribeAccounts = subscribeProviderAccountsEvents("openai-codex", (state) => accountStates.push(state));

assert.equal(FakeEventSource.instances.length, 1, "all control-plane consumers must share one global SSE");
assert.match(FakeEventSource.instances[0]!.url, /\/api\/events$/u);
FakeEventSource.instances[0]?.onopen?.();
assert.equal(goalActivityChanges, 1, "the first SSE open must close the initial load-to-subscribe race");
assert.equal(globalActivityChanges, 1, "the first SSE open must converge global activity state");
FakeEventSource.instances[0]?.onopen?.();
assert.equal(goalActivityChanges, 2, "a later SSE open must converge Goal activity state");
assert.equal(globalActivityChanges, 2, "a later SSE open must converge global activity state");
const unsubscribeSession = subscribeGoalSessionEvents("goal_shared", (state) => sessionStates.push(state));
assert.equal(FakeEventSource.instances.length, 2, "adding a Goal session must replace the global transport");
assert.equal(FakeEventSource.instances[0]?.closed, true, "the replaced transport must close immediately");
assert.match(FakeEventSource.instances[1]!.url, /\/api\/events\?goalId=goal_shared$/u);
assert.equal(FakeEventSource.instances.filter((source) => !source.closed).length, 1, "one tab must keep one SSE open");
const activeSource = FakeEventSource.instances[1]!;
activeSource.onopen?.();
activeSource.emit({
	type: "snapshot",
	goals: [],
	accounts: { "openai-codex": { activeAccountId: "account-1" } },
});
assert.equal(firstEvents.length, 1);
assert.deepEqual(accountStates, [{ activeAccountId: "account-1" }]);
activeSource.emit({
	type: "goal-session:snapshot",
	goalId: "goal_shared",
	state: { goalId: "goal_shared", messages: [], isStreaming: false },
});
assert.equal(sessionStates.length, 1, "the scoped Goal snapshot must use the same physical SSE");
assert.equal(firstEvents.length, 1, "Goal snapshots must not leak into control-plane listeners");

activeSource.emit({ type: "activity-projection:changed", goalId: "goal_shared" });
assert.equal(scopedEvents.length, 1);
assert.equal(goalActivityChanges, 4);
assert.equal(globalActivityChanges, 4);
activeSource.emit({ type: "wiki-update:changed", goalId: "goal_shared", status: "succeeded" });
assert.equal(wikiEvents.length, 1);
assert.equal(goalActivityChanges, 5, "Wiki lifecycle changes must refresh Goal activity");
assert.equal(globalActivityChanges, 5, "Wiki lifecycle changes must refresh global activity");
activeSource.emit({ type: "account:changed", scope: "global", provider: "openai-codex", state: { activeAccountId: "account-2" } });
assert.deepEqual(accountStates.at(-1), { activeAccountId: "account-2" });
assert.equal(goalActivityChanges, 5, "account changes must not refresh Goal activity");
assert.equal(globalActivityChanges, 5, "account changes must not refresh global activity");

unsubscribeFirst();
unsubscribeScoped();
unsubscribeActivity();
unsubscribeGlobalActivity();
unsubscribeWiki();
unsubscribeAccounts();
unsubscribeSession();
const unsubscribeRemount = subscribeGoalsEvents(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(FakeEventSource.instances.filter((source) => !source.closed).length, 1, "StrictMode remount must keep one global SSE");

unsubscribeRemount();
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(FakeEventSource.instances.filter((source) => !source.closed).length, 0, "the global SSE must close after its final consumer leaves");

console.log("shared global SSE test passed");
