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

	emit(data: string): void {
		this.onmessage?.({ data } as MessageEvent<string>);
	}
}

const fakeWindow = new EventTarget();
Object.assign(globalThis, { EventSource: FakeEventSource, window: fakeWindow });

const {
	refreshOnReconnect,
	subscribeSharedEventSource,
} = await import("../../web/src/shared/lib/sharedEventSource.js");

let reconnectRefreshes = 0;
const connectionStates: boolean[] = [];
const onConnectionChange = refreshOnReconnect(
	() => { reconnectRefreshes += 1; },
	(connected) => connectionStates.push(connected),
);
onConnectionChange(true);
assert.equal(reconnectRefreshes, 1, "the first open must close the initial GET-to-subscribe race");
onConnectionChange(false);
onConnectionChange(true);
assert.equal(reconnectRefreshes, 2, "a later open must refresh the authoritative resource snapshot");
assert.deepEqual(connectionStates, [true, false, true]);

const firstMessages: string[] = [];
const secondMessages: string[] = [];
const unsubscribeFirst = subscribeSharedEventSource("/events/shared", {
	onMessage: (event) => firstMessages.push(event.data),
});
const unsubscribeSecond = subscribeSharedEventSource("/events/shared", {
	onMessage: (event) => secondMessages.push(event.data),
});

assert.equal(
	FakeEventSource.instances.length,
	1,
	"subscribers for one URL must share one physical EventSource",
);
FakeEventSource.instances[0]?.emit("payload");
assert.deepEqual(firstMessages, ["payload"]);
assert.deepEqual(secondMessages, ["payload"]);

unsubscribeFirst();
unsubscribeSecond();
const unsubscribeRemount = subscribeSharedEventSource("/events/shared", {});
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(
	FakeEventSource.instances.length,
	1,
	"StrictMode cleanup-remount must reuse the physical EventSource",
);
assert.equal(FakeEventSource.instances[0]?.closed, false);

const unsubscribeOther = subscribeSharedEventSource("/events/other", {});
assert.equal(
	FakeEventSource.instances.length,
	2,
	"different SSE URLs must keep independent physical streams",
);

unsubscribeRemount();
unsubscribeOther();
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(FakeEventSource.instances[0]?.closed, true);
assert.equal(FakeEventSource.instances[1]?.closed, true);

const activeUnsubscribers = Array.from({ length: 5 }, (_, index) => (
	subscribeSharedEventSource(`/events/capacity-${index}`, {})
));
const externalConnection = new FakeEventSource("/events/external");
const openConnectionCount = () => FakeEventSource.instances.filter((source) => !source.closed).length;
assert.equal(openConnectionCount(), 6, "the repro must saturate a six-connection HTTP/1 pool");

fakeWindow.dispatchEvent(new Event("pagehide"));
assert.equal(
	openConnectionCount(),
	1,
	"page unload must close shared SSE streams before the replacement page opens connections",
);
fakeWindow.dispatchEvent(new Event("pageshow"));
assert.equal(openConnectionCount(), 6, "BFCache restore must reconnect active subscriptions");
fakeWindow.dispatchEvent(new Event("beforeunload"));
assert.equal(
	openConnectionCount(),
	1,
	"hard reload must close shared SSE streams before the replacement page opens connections",
);
fakeWindow.dispatchEvent(new Event("pageshow"));
assert.equal(openConnectionCount(), 6, "a restored page must reconnect after beforeunload cleanup");

for (const unsubscribe of activeUnsubscribers) unsubscribe();
externalConnection.close();
await new Promise((resolve) => setTimeout(resolve, 300));

const unsubscribeStuck = subscribeSharedEventSource("/events/stuck-connecting", {});
const stuckConnection = FakeEventSource.instances.at(-1)!;
stuckConnection.readyState = 0;
stuckConnection.onerror?.();
assert.equal(
	stuckConnection.closed,
	true,
	"an errored CONNECTING EventSource must be closed so reconnect can acquire a fresh slot",
);
unsubscribeStuck();
await new Promise((resolve) => setTimeout(resolve, 300));

const originalFetch = globalThis.fetch;
let snapshotFetches = 0;
const staleSnapshot = { goalId: "goal-race", messages: [], isStreaming: true };
const settledSnapshot = { ...staleSnapshot, isStreaming: false };
globalThis.fetch = async () => new Response(JSON.stringify({
	state: snapshotFetches++ === 0 ? staleSnapshot : settledSnapshot,
}), { status: 200, headers: { "content-type": "application/json" } });
const { LiveSession } = await import("../../web/src/features/goals/data/LiveSession.js");
const liveSession = new LiveSession("goal-race");
const snapshots: Array<{ isStreaming: boolean }> = [];
liveSession.onSnapshot((snapshot) => snapshots.push(snapshot as { isStreaming: boolean }));
await liveSession.init();
FakeEventSource.instances.at(-1)?.onopen?.();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(snapshotFetches, 2, "the first live connection must refresh after subscribing");
assert.equal(snapshots.at(-1)?.isStreaming, false, "the live session must converge after a missed terminal event");
liveSession.disconnect();

let pendingFetches = 0;
const pendingUser = { role: "user", content: "find Luna-TTS", timestamp: 1 };
const pendingTool = {
	role: "assistant",
	content: [{ type: "toolCall", id: "wiki-call", name: "wiki_search", arguments: { query: "Luna-TTS" } }],
	timestamp: 2,
};
globalThis.fetch = async () => new Response(JSON.stringify({
	state: {
		goalId: "goal-pending-stream",
		messages: pendingFetches++ === 0 ? [pendingUser] : [pendingUser, pendingTool],
		isStreaming: true,
		pendingToolCalls: ["wiki-call"],
	},
}), { status: 200, headers: { "content-type": "application/json" } });
const pendingSession = new LiveSession("goal-pending-stream");
await pendingSession.init();
FakeEventSource.instances.at(-1)!.readyState = 0;
await new Promise((resolve) => setTimeout(resolve, 1_100));
assert.equal(pendingFetches, 2, "a pending SSE must poll the authoritative Goal snapshot");
assert.equal(pendingSession.snapshot?.messages.length, 2, "polling must surface a running tool before SSE opens");
pendingSession.disconnect();
globalThis.fetch = originalFetch;

console.log("shared EventSource lifecycle test passed");
