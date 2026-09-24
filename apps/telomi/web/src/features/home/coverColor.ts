// Muted, paper-friendly per-goal accent palette (mirrors the redesign demo's
// --cover swatches). Deterministic by goalId so a goal keeps its color across
// the volume list and the activity wall.
const COVERS = ["#D97A3C", "#5E7E8B", "#C77B8B", "#7E8B5E", "#9A6B4F", "#6E8B7E", "#8B6E9A"];

export function coverColor(goalId: string): string {
	let h = 0;
	for (let i = 0; i < goalId.length; i++) h = (h * 31 + goalId.charCodeAt(i)) | 0;
	return COVERS[Math.abs(h) % COVERS.length];
}
