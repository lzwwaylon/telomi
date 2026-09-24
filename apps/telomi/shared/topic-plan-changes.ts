interface Topic {
	id: string;
	title: string;
	intent: string;
	questions: readonly string[];
	include: readonly string[];
	exclude: readonly string[];
}

/** Compare confirmed Topic identities and their user-facing content, not revision metadata. */
export function getTopicPlanChanges<T extends Topic>(before: readonly T[], after: readonly T[]) {
	const previous = new Map(before.map((topic) => [topic.id, topic]));
	const next = new Map(after.map((topic) => [topic.id, topic]));
	const content = (topic: Topic) => JSON.stringify([topic.title, topic.intent, topic.questions, topic.include, topic.exclude]);
	return {
		added: after.filter((topic) => !previous.has(topic.id)),
		updated: after.filter((topic) => {
			const old = previous.get(topic.id);
			return old !== undefined && content(old) !== content(topic);
		}),
		removed: before.filter((topic) => !next.has(topic.id)),
		reordered: JSON.stringify(before.filter((topic) => next.has(topic.id)).map((topic) => topic.id))
			!== JSON.stringify(after.filter((topic) => previous.has(topic.id)).map((topic) => topic.id)),
	};
}
