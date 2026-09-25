import { createLucideIcon } from "lucide-react";

// Telomi soft-ink shapes, drawn on a 24px grid. The app provider sets the 1.75px stroke.

export const HomeIcon = createLucideIcon("telomi-home", [
	["path", { d: "M3.5 10.5 10 5a3 3 0 0 1 4 0l6.5 5.5M5.5 9.5v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9M10 20v-5a2 2 0 0 1 4 0v5", key: "0" }],
]);

export const TopicPlanIcon = createLucideIcon("telomi-topics", [
	["path", { d: "M5 4v12c0 3 2 4 5 4h6M5 7c0 4 5 2 9 2M5 12c0 4 4 3 8 3", key: "0" }],
	["circle", { cx: "16.5", cy: "9", r: "1.5", key: "1" }],
	["circle", { cx: "15.5", cy: "15", r: "1.5", key: "2" }],
	["circle", { cx: "18.5", cy: "20", r: "1.5", key: "3" }],
]);

export const BookIcon = createLucideIcon("telomi-wiki", [
	["path", { d: "M12 6v15M12 6C9 3.5 6 3.5 3 4.5v14c3-1 6-.5 9 2 3-2.5 6-3 9-2v-14c-3-1-6-1-9 1.5Z", key: "0" }],
]);

export const MemoryIcon = createLucideIcon("telomi-memory", [
	["path", { d: "M7 3.5h10a2 2 0 0 1 2 2V20.5l-7-4.2-7 4.2V5.5a2 2 0 0 1 2-2Z", key: "0" }],
	["path", { d: "M9.5 8.5h5", key: "1" }],
]);

export const DocumentIcon = createLucideIcon("telomi-report", [
	["path", { d: "M14 3H7a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V9l-6-6Zm0 0v4a2 2 0 0 0 2 2h4M8 12h8M8 16h5", key: "0" }],
]);

export const ChatIcon = createLucideIcon("telomi-chat", [
	["path", { d: "M8 20c-1.5 1-3 1-4 1l1-4c-1.3-1.4-2-3-2-5C3 6.8 6.7 4 12 4s9 2.8 9 8-3.7 8-9 8H8Z", key: "0" }],
	["path", { d: "M8 11h8M8 15h4", key: "1" }],
]);

export const CompassIcon = createLucideIcon("telomi-discover", [
	["circle", { cx: "12", cy: "12", r: "9", key: "0" }],
	["path", { d: "m15.7 8.3-2.2 5.2-5.2 2.2 2.2-5.2 5.2-2.2Z", key: "1" }],
]);

export const ActivityIcon = createLucideIcon("telomi-activity", [
	["circle", { cx: "5", cy: "6", r: "1", key: "0" }],
	["circle", { cx: "5", cy: "12", r: "1", key: "1" }],
	["circle", { cx: "5", cy: "18", r: "1", key: "2" }],
	["path", { d: "M10 6h9M10 12h6M10 18h8", key: "3" }],
]);

export const HeadphonesIcon = createLucideIcon("telomi-audio", [
	["path", { d: "M4 14v-2a8 8 0 0 1 16 0v2", key: "0" }],
	["rect", { x: "3", y: "12", width: "5", height: "8", rx: "2.5", key: "1" }],
	["rect", { x: "16", y: "12", width: "5", height: "8", rx: "2.5", key: "2" }],
]);

export const SettingsIcon = createLucideIcon("telomi-settings", [
	["path", { d: "M3 7h4m6 0h8M3 17h10m6 0h2", key: "0" }],
	["circle", { cx: "10", cy: "7", r: "3", key: "1" }],
	["circle", { cx: "16", cy: "17", r: "3", key: "2" }],
]);

export const SearchIcon = createLucideIcon("telomi-search", [
	["circle", { cx: "10.5", cy: "10.5", r: "6.5", key: "0" }],
	["path", { d: "m15.5 15.5 5 5", key: "1" }],
]);

export const CalendarIcon = createLucideIcon("telomi-schedule", [
	["rect", { x: "3.5", y: "5", width: "17", height: "16", rx: "3", key: "0" }],
	["path", { d: "M8 3v4m8-4v4M4 10h16m-12 5h3m-3 3h6", key: "1" }],
]);

export const BrowserIcon = createLucideIcon("telomi-browser", [
	["path", { d: "M10 20H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4M7 8h5", key: "window" }],
	["path", { d: "m13 12 8 4-4 1.5-1.5 4L13 12Z", key: "cursor" }],
]);

export const BellIcon = createLucideIcon("telomi-bell", [
	["path", { d: "M6 10a6 6 0 0 1 12 0v2c0 2 1 3 2 4q1 1.5-1 2c-4 1-10 1-14 0q-2-.5-1-2c1-1 2-2 2-4v-2Zm4 11q2 1 4 0", key: "bell" }],
]);

export const PencilIcon = createLucideIcon("telomi-pencil", [
	["path", { d: "m5.5 15.5 10-10a2.5 2.5 0 0 1 3.5 3.5l-10 10-5 1.5 1.5-5Zm0 0L9 19", key: "pencil" }],
]);

export const PlayIcon = createLucideIcon("telomi-play", [
	["path", { d: "M8 5.5q0-1.3 1.2-.6l10 6q1.8 1.1 0 2.2l-10 6q-1.2.7-1.2-.6Z", key: "play" }],
]);

export const RunIcon = createLucideIcon("telomi-run", [
	["circle", { cx: "12", cy: "12", r: "9", key: "circle" }],
	["path", { d: "M10 8.5q0-.8.7-.4l5.1 3.1q1.2.8 0 1.6l-5.1 3.1q-.7.4-.7-.4Z", key: "play" }],
]);

export const PauseIcon = createLucideIcon("telomi-pause", [
	["rect", { x: "6", y: "5", width: "3.5", height: "14", rx: "1.75", key: "left" }],
	["rect", { x: "14.5", y: "5", width: "3.5", height: "14", rx: "1.75", key: "right" }],
]);

export const ArchiveIcon = createLucideIcon("telomi-archive", [
	["rect", { x: "3", y: "4", width: "18", height: "4", rx: "1.5", key: "lid" }],
	["path", { d: "M5 8v9a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8M9 12h6", key: "box" }],
]);

export const ReviewIcon = createLucideIcon("telomi-review", [
	["path", { d: "M12 4H7a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6M8 11h3m-3 5h8", key: "note" }],
	["circle", { cx: "18", cy: "5", r: "2.5", key: "attention" }],
]);

export const CopyIcon = createLucideIcon("telomi-copy", [
	["rect", { x: "8", y: "8", width: "12", height: "13", rx: "3", key: "front" }],
	["path", { d: "M4 15V6a3 3 0 0 1 3-3h8", key: "back" }],
]);

export const DownloadIcon = createLucideIcon("telomi-download", [
	["path", { d: "M12 3v12m-4-4 4 4 4-4M4 15v2a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-2", key: "download" }],
]);

export const PlusIcon = createLucideIcon("telomi-plus", [
	["path", { d: "M12 5v14M5 12h14", key: "plus" }],
]);

export const CloseIcon = createLucideIcon("telomi-close", [
	["path", { d: "m6 6 12 12M6 18 18 6", key: "close" }],
]);

export const ArrowLeftIcon = createLucideIcon("telomi-arrow-left", [
	["path", { d: "M20 12H4m6-6-5.3 5.3q-.7.7 0 1.4L10 18", key: "arrow" }],
]);

export const ArrowRightIcon = createLucideIcon("telomi-arrow-right", [
	["path", { d: "M4 12h16m-6-6 5.3 5.3q.7.7 0 1.4L14 18", key: "arrow" }],
]);
