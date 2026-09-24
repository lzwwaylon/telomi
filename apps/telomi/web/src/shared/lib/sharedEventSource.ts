export interface SharedEventSourceHandlers {
	onOpen?: () => void;
	onMessage?: (event: MessageEvent<string>) => void;
	onError?: () => void;
}

interface SharedConnection {
	url: string;
	subscribers: Set<SharedEventSourceHandlers>;
	source: EventSource | null;
	connected: boolean;
	closeTimer: ReturnType<typeof setTimeout> | null;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const STRICT_MODE_GRACE_MS = 250;
const RECONNECT_DELAY_MS = 5_000;
const connections = new Map<string, SharedConnection>();

if (typeof window !== "undefined") {
	const suspendAll = () => {
		for (const connection of connections.values()) suspendConnection(connection);
	};
	window.addEventListener("pagehide", suspendAll);
	window.addEventListener("beforeunload", suspendAll);
	window.addEventListener("pageshow", () => {
		for (const connection of connections.values()) openConnection(connection);
	});
}

/**
 * Share one physical EventSource per URL across components. The close grace
 * absorbs React StrictMode's setup-cleanup-setup audit so closing sockets do
 * not temporarily consume the browser's HTTP/1.1 connection pool.
 */
export function subscribeSharedEventSource(
	url: string,
	handlers: SharedEventSourceHandlers,
): (immediate?: boolean) => void {
	const connection = getConnection(url);
	cancelClose(connection);
	connection.subscribers.add(handlers);
	openConnection(connection);
	if (connection.connected) handlers.onOpen?.();

	return (immediate = false) => {
		connection.subscribers.delete(handlers);
		if (immediate) closeIfIdle(connection);
		else scheduleClose(connection);
	};
}

/** Refresh after subscribing so events cannot land between the initial GET and SSE open. */
export function refreshOnReconnect(
	refresh: () => void,
	onConnectionChange?: (connected: boolean) => void,
): (connected: boolean) => void {
	return (connected) => {
		onConnectionChange?.(connected);
		if (!connected) return;
		refresh();
	};
}

function getConnection(url: string): SharedConnection {
	const existing = connections.get(url);
	if (existing) return existing;
	const connection: SharedConnection = {
		url,
		subscribers: new Set(),
		source: null,
		connected: false,
		closeTimer: null,
		reconnectTimer: null,
	};
	connections.set(url, connection);
	return connection;
}

function openConnection(connection: SharedConnection): void {
	if (connection.source || connection.subscribers.size === 0) return;
	const source = new EventSource(connection.url);
	connection.source = source;
	source.onopen = () => {
		if (connection.source !== source) return;
		connection.connected = true;
		notify(connection, "onOpen");
	};
	source.onmessage = (event) => {
		if (connection.source !== source) return;
		for (const subscriber of [...connection.subscribers]) {
			try {
				subscriber.onMessage?.(event);
			} catch (error) {
				console.warn("[shared-event-source] message handler threw", error);
			}
		}
	};
	source.onerror = () => {
		if (connection.source !== source) return;
		connection.connected = false;
		notify(connection, "onError");
		source.close();
		connection.source = null;
		cancelReconnect(connection);
		if (connection.subscribers.size === 0) return;
		connection.reconnectTimer = setTimeout(() => {
			connection.reconnectTimer = null;
			openConnection(connection);
		}, RECONNECT_DELAY_MS);
	};
}

function suspendConnection(connection: SharedConnection): void {
	cancelReconnect(connection);
	connection.source?.close();
	connection.source = null;
	connection.connected = false;
}

function notify(
	connection: SharedConnection,
	key: "onOpen" | "onError",
): void {
	for (const subscriber of [...connection.subscribers]) {
		try {
			subscriber[key]?.();
		} catch (error) {
			console.warn(`[shared-event-source] ${key} handler threw`, error);
		}
	}
}

function scheduleClose(connection: SharedConnection): void {
	if (connection.subscribers.size > 0 || connection.closeTimer) return;
	cancelReconnect(connection);
	connection.closeTimer = setTimeout(() => {
		closeIfIdle(connection);
	}, STRICT_MODE_GRACE_MS);
}

function closeIfIdle(connection: SharedConnection): void {
	if (connection.subscribers.size > 0) return;
	cancelClose(connection);
	cancelReconnect(connection);
	connection.source?.close();
	connection.source = null;
	connection.connected = false;
	connections.delete(connection.url);
}

function cancelClose(connection: SharedConnection): void {
	if (!connection.closeTimer) return;
	clearTimeout(connection.closeTimer);
	connection.closeTimer = null;
}

function cancelReconnect(connection: SharedConnection): void {
	if (!connection.reconnectTimer) return;
	clearTimeout(connection.reconnectTimer);
	connection.reconnectTimer = null;
}
