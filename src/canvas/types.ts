// Local structural types matching what tldraw sends over the wire.
// Do NOT import from 'tldraw' here — that package is frontend-only.

export interface CanvasShape {
	id: string // format: "shape:xxxxxxxx"
	type: string // "note" | "text" | "geo" | "arrow" | "frame" | "group" | "image" | "draw" | ...
	x: number
	y: number
	rotation: number
	parentId: string // page ID or group/frame ID
	props: Record<string, unknown>
	meta?: Record<string, unknown> // optional metadata (e.g. aiGenerated, aiPrompt)
}

export interface CanvasAsset {
	id: string // format: "asset:xxxxxxxx"
	type: string // "image" | "video" | "bookmark"
	props: {
		name?: string
		src?: string
		w?: number
		h?: number
		mimeType?: string
		isAnimated?: boolean
	}
}

export interface CanvasBinding {
	id: string
	type: string // "arrow"
	fromId: string // arrow shape ID
	toId: string // target shape ID
	props: {
		terminal: 'start' | 'end'
		isExact: boolean
		isPrecise: boolean
		normalizedAnchor: { x: number; y: number }
	}
}

export interface CanvasSnapshot {
	shapes: CanvasShape[] // editor.getCurrentPageShapes()
	bindings: CanvasBinding[] // editor.getCurrentPageBindings()
	assets?: CanvasAsset[] // editor asset records (images, videos)
}

/** Lightweight description of an image on the canvas for voice command context */
export interface CanvasImageInfo {
	shapeId: string
	assetId?: string
	x: number
	y: number
	w?: number
	h?: number
	src?: string
	aiGenerated?: boolean
	aiPrompt?: string
	name?: string
}
