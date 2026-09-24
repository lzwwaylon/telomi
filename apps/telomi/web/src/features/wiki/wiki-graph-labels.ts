interface GraphLabel {
	id: string;
	x: number;
	y: number;
	radius: number;
	width: number;
	height: number;
	priority: number;
	importance: number;
}

interface Bounds { left: number; top: number; right: number; bottom: number }

/** Place the most useful labels first, keeping every accepted label readable. */
export function placeGraphLabels<T extends GraphLabel>(labels: T[], bounds: Bounds, gap: number, obstacles: Bounds[] = []): T[] {
	const placed: T[] = [];
	for (const label of [...labels].sort((a, b) => b.priority - a.priority || b.importance - a.importance || a.id.localeCompare(b.id))) {
		if (label.x < bounds.left || label.x > bounds.right || label.y < bounds.top || label.y > bounds.bottom) continue;
		if (label.width > bounds.right - bounds.left || label.height > bounds.bottom - bounds.top) continue;
		const x = Math.max(bounds.left, Math.min(label.x - label.width / 2, bounds.right - label.width));
		for (const y of [label.y + label.radius + gap, label.y - label.radius - gap - label.height]) {
			if (y < bounds.top || y + label.height > bounds.bottom) continue;
			if (obstacles.some((other) => x < other.right + gap && x + label.width + gap > other.left && y < other.bottom + gap && y + label.height + gap > other.top)) continue;
			// ponytail: pairwise checks suit the visible labels; use a spatial index if dense graphs make painting slow.
			if (placed.some((other) => x < other.x + other.width + gap && x + label.width + gap > other.x && y < other.y + other.height + gap && y + label.height + gap > other.y)) continue;
			placed.push({ ...label, x, y });
			break;
		}
	}
	return placed;
}
