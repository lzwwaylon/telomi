export async function mapConcurrentFairly<T, R>(
	items: readonly T[],
	concurrency: number,
	action: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let admission = Promise.resolve();
	const enterOnNextTurn = (): Promise<void> => {
		const turn = admission.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
		admission = turn;
		return turn;
	};
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			signal?.throwIfAborted();
			const index = next;
			next += 1;
			if (index >= items.length) return;
			await enterOnNextTurn();
			signal?.throwIfAborted();
			results[index] = await action(items[index]!, index);
		}
	});
	const settled = await Promise.allSettled(workers);
	const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (failed) throw failed.reason;
	return results;
}
