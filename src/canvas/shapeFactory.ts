import {
	createShapeId,
	createBindingId,
	toRichText,
	type TLShapeId,
	type TLBindingId,
} from "@tldraw/tlschema";
import { getIndicesAbove, type IndexKey } from "@tldraw/utils";

const AGENT_META = { aiGenerated: true } as const;
const DEFAULT_PAGE = "page:page";

type NoteColor =
	| "yellow"
	| "orange"
	| "green"
	| "blue"
	| "violet"
	| "light-gray"
	| "gray";

const ALLOWED_NOTE_COLORS = new Set<NoteColor>([
	"yellow",
	"orange",
	"green",
	"blue",
	"violet",
	"light-gray",
	"gray",
]);

function normalizeNoteColor(color?: string): NoteColor {
	if (color && ALLOWED_NOTE_COLORS.has(color as NoteColor))
		return color as NoteColor;
	return "yellow";
}

export function generateIndices(count: number, above?: IndexKey): IndexKey[] {
	return getIndicesAbove(above ?? null, count);
}

export function findHighestIndex(records: Array<{ index?: string }>): IndexKey | undefined {
	let highest: string | undefined;
	for (const r of records) {
		if (r.index && (!highest || r.index > highest)) highest = r.index;
	}
	return highest as IndexKey | undefined;
}

export function createNoteRecord(opts: {
	content: string;
	x: number;
	y: number;
	color?: string;
	index: IndexKey;
	id?: TLShapeId;
}) {
	return {
		id: opts.id ?? createShapeId(),
		typeName: "shape" as const,
		type: "note" as const,
		x: opts.x,
		y: opts.y,
		rotation: 0,
		index: opts.index,
		parentId: DEFAULT_PAGE,
		isLocked: false,
		opacity: 1,
		meta: AGENT_META,
		props: {
			color: normalizeNoteColor(opts.color),
			labelColor: "black",
			size: "m" as const,
			font: "draw" as const,
			fontSizeAdjustment: 0,
			align: "middle" as const,
			verticalAlign: "middle" as const,
			growY: 0,
			url: "",
			richText: toRichText(opts.content),
			scale: 1,
		},
	};
}

export function createTextRecord(opts: {
	content: string;
	x: number;
	y: number;
	index: IndexKey;
	id?: TLShapeId;
}) {
	return {
		id: opts.id ?? createShapeId(),
		typeName: "shape" as const,
		type: "text" as const,
		x: opts.x,
		y: opts.y,
		rotation: 0,
		index: opts.index,
		parentId: DEFAULT_PAGE,
		isLocked: false,
		opacity: 1,
		meta: AGENT_META,
		props: {
			color: "white" as const,
			size: "m" as const,
			font: "draw" as const,
			textAlign: "start" as const,
			richText: toRichText(opts.content),
			autoSize: true,
			scale: 1,
			w: 200,
		},
	};
}

export function createArrowRecord(opts: {
	x?: number;
	y?: number;
	index: IndexKey;
	label?: string;
	id?: TLShapeId;
}) {
	const record: Record<string, unknown> = {
		id: opts.id ?? createShapeId(),
		typeName: "shape" as const,
		type: "arrow" as const,
		x: opts.x ?? 0,
		y: opts.y ?? 0,
		rotation: 0,
		index: opts.index,
		parentId: DEFAULT_PAGE,
		isLocked: false,
		opacity: 1,
		meta: AGENT_META,
		props: {
			dash: "draw" as const,
			size: "m" as const,
			fill: "none" as const,
			color: "white" as const,
			labelColor: "white" as const,
			bend: 0,
			start: { x: 0, y: 0 },
			end: { x: 100, y: 100 },
			arrowheadStart: "none" as const,
			arrowheadEnd: "arrow" as const,
			richText: opts.label ? toRichText(opts.label) : toRichText(""),
			labelPosition: 0.5,
			scale: 1,
		},
	};
	return record;
}

export function createArrowBindingRecord(opts: {
	arrowId: TLShapeId;
	targetId: string;
	terminal: "start" | "end";
	index: IndexKey;
	id?: TLBindingId;
}) {
	return {
		id: opts.id ?? createBindingId(),
		typeName: "binding" as const,
		type: "arrow" as const,
		fromId: opts.arrowId,
		toId: opts.targetId,
		index: opts.index,
		meta: {},
		props: {
			terminal: opts.terminal,
			isExact: false,
			isPrecise: false,
			normalizedAnchor: { x: 0.5, y: 0.5 },
		},
	};
}

export function createFrameRecord(opts: {
	x: number;
	y: number;
	w: number;
	h: number;
	name?: string;
	index: IndexKey;
	id?: TLShapeId;
}) {
	return {
		id: opts.id ?? createShapeId(),
		typeName: "shape" as const,
		type: "frame" as const,
		x: opts.x,
		y: opts.y,
		rotation: 0,
		index: opts.index,
		parentId: DEFAULT_PAGE,
		isLocked: false,
		opacity: 1,
		meta: AGENT_META,
		props: {
			w: Math.max(200, opts.w),
			h: Math.max(200, opts.h),
			name: opts.name ?? "AI Group",
		},
	};
}

export function createGeoRecord(opts: {
	x: number;
	y: number;
	w: number;
	h: number;
	geo?: string;
	label?: string;
	index: IndexKey;
	id?: TLShapeId;
}) {
	return {
		id: opts.id ?? createShapeId(),
		typeName: "shape" as const,
		type: "geo" as const,
		x: opts.x,
		y: opts.y,
		rotation: 0,
		index: opts.index,
		parentId: DEFAULT_PAGE,
		isLocked: false,
		opacity: 1,
		meta: AGENT_META,
		props: {
			geo: opts.geo ?? "rectangle",
			w: opts.w,
			h: opts.h,
			dash: "draw" as const,
			size: "m" as const,
			fill: "none" as const,
			color: "white" as const,
			labelColor: "white" as const,
			richText: opts.label ? toRichText(opts.label) : toRichText(""),
			font: "draw" as const,
			textAlign: "middle" as const,
			verticalAlign: "middle" as const,
			growY: 0,
			url: "",
			scale: 1,
		},
	};
}
