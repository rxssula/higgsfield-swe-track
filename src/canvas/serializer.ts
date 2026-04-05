import type { CanvasShape, CanvasSnapshot } from './types'
import { findClusters, getRegionLabel } from './spatial'

interface SerializedElement {
	id: string
	type: CanvasShape['type']
	content?: string
	color?: string
	x: number
	y: number
	rotation: number
	region: string
	w?: number
	h?: number
	parentId?: string
	connections?: {
		bindingId: string
		role: 'from' | 'to'
		targetId: string
	}[]
}

export function serializeCanvasState(snapshot: CanvasSnapshot) {
	const { shapes, bindings } = snapshot
	const stats = computeStats(shapes)
	const bounds = computeBounds(shapes)
	const elements: SerializedElement[] = shapes.map((shape) => serializeElement(shape, bindings))
	const clusters = findClusters(shapes).map((cluster, index) => ({
		id: `cluster-${index + 1}`,
		memberIds: cluster.shapeIds,
		centroid: cluster.centroid,
		region: getRegionLabel(cluster.centroid),
	}))
	const connections = bindings
		.filter((b) => b.type === 'arrow')
		.map((binding) => ({
			id: binding.id,
			fromId: binding.fromId,
			toId: binding.toId,
			terminal: binding.props?.terminal ?? 'end',
		}))

	return JSON.stringify(
		{
			meta: {
				shapeCount: shapes.length,
				bindingCount: bindings.length,
				clusters: clusters.length,
				noteCount: stats.noteCount,
				textCount: stats.textCount,
				arrowCount: stats.arrowCount,
				imageCount: stats.imageCount,
				bounds,
			},
			clusters,
			elements,
			connections,
		},
		null,
		0,
	)
}

function serializeElement(shape: CanvasShape, bindings: CanvasSnapshot['bindings']): SerializedElement {
	const content = extractText(shape)
	const w = typeof shape.props?.w === 'number' ? shape.props.w : undefined
	const h = typeof shape.props?.h === 'number' ? shape.props.h : undefined
	const relatedBindings = bindings.filter(
		(b) => b.fromId === shape.id || b.toId === shape.id,
	)

	return {
		id: shape.id,
		type: shape.type,
		content: content || undefined,
		color: typeof shape.props?.color === 'string' ? shape.props.color : undefined,
		x: shape.x,
		y: shape.y,
		rotation: shape.rotation,
		region: getRegionLabel(shape),
		w,
		h,
		parentId: shape.parentId,
		connections: relatedBindings.map((binding) => ({
			bindingId: binding.id,
			role: binding.fromId === shape.id ? 'from' : 'to',
			targetId: binding.fromId === shape.id ? binding.toId : binding.fromId,
		})),
	}
}

function computeStats(shapes: CanvasShape[]) {
	let noteCount = 0
	let textCount = 0
	let arrowCount = 0
	let imageCount = 0
	for (const shape of shapes) {
		switch (shape.type) {
			case 'note':
				noteCount++
				break
			case 'text':
				textCount++
				break
			case 'arrow':
				arrowCount++
				break
			case 'image':
				imageCount++
				break
		}
	}
	return { noteCount, textCount, arrowCount, imageCount }
}

function computeBounds(shapes: CanvasShape[]) {
	if (shapes.length === 0) return null
	const minX = Math.min(...shapes.map((s) => s.x))
	const minY = Math.min(...shapes.map((s) => s.y))
	const maxX = Math.max(
		...shapes.map((s) => s.x + (typeof s.props?.w === 'number' ? s.props.w : 0)),
	)
	const maxY = Math.max(
		...shapes.map((s) => s.y + (typeof s.props?.h === 'number' ? s.props.h : 0)),
	)
	return { minX, minY, maxX, maxY }
}

function extractText(shape: CanvasShape) {
	const p = shape.props ?? {}
	if (p.richText && typeof p.richText === 'object') {
		return extractRichText(p.richText).trim()
	}
	if (typeof p.text === 'string') return p.text.trim()
	if (typeof p.name === 'string') return p.name.trim()
	return ''
}

function extractRichText(node: any): string {
	if (!node || typeof node !== 'object') return ''
	if (typeof node.text === 'string') return node.text
	if (Array.isArray(node.content)) {
		return node.content.map(extractRichText).join('')
	}
	return ''
}
