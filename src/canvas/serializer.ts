import type { CanvasShape, CanvasSnapshot } from './types'
import { findClusters, getRegionLabel } from './spatial'

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

// Recursively walks a ProseMirror JSON node to extract plain text.
// tldraw v3+ stores all text as richText (ProseMirror doc), not plain strings.
function extractRichText(node: unknown): string {
	if (!node || typeof node !== 'object') return ''
	const n = node as Record<string, unknown>
	if (typeof n.text === 'string') return n.text
	if (Array.isArray(n.content)) {
		return (n.content as unknown[]).map(extractRichText).join('')
	}
	return ''
}

function extractText(shape: CanvasShape): string {
	const p = shape.props
	if (p.richText) return extractRichText(p.richText).trim()
	if (typeof p.text === 'string') return p.text.trim()
	if (typeof p.name === 'string') return p.name.trim()
	return ''
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return Math.sqrt(dx * dx + dy * dy)
}

function findNearbyText(
	targetShapes: CanvasShape[],
	allShapes: CanvasShape[],
	threshold = 500
): string[] {
	const textLike = allShapes.filter(
		(s) => s.type === 'text' || s.type === 'note' || s.type === 'geo'
	)
	const seen = new Set<string>()
	const results: string[] = []
	for (const target of targetShapes) {
		for (const t of textLike) {
			if (seen.has(t.id)) continue
			const text = extractText(t)
			if (!text) continue
			if (dist(target, t) <= threshold) {
				seen.add(t.id)
				results.push(`"${text}"`)
			}
		}
	}
	return results
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export function serializeCanvasState(snapshot: CanvasSnapshot): string {
	const { shapes, bindings } = snapshot
	const sections: string[] = []

	// Build lookup maps used across sections
	const shapeById = new Map(shapes.map((s) => [s.id, s]))

	// --- 1. CANVAS OVERVIEW ---
	const typeCounts: Record<string, number> = {}
	for (const s of shapes) typeCounts[s.type] = (typeCounts[s.type] ?? 0) + 1
	const get = (type: string) => typeCounts[type] ?? 0
	const overviewSummary = [
		`${get('note')} sticky notes`,
		`${get('geo')} shapes`,
		`${get('text')} text blocks`,
		`${get('arrow')} arrows`,
		`${get('frame')} frames`,
		`${get('draw')} drawings`,
		`${get('group')} groups`,
	].join(', ')
	sections.push(`CANVAS OVERVIEW: ${shapes.length} elements — ${overviewSummary}.`)

	// --- 2. SPATIAL CLUSTERS OF STICKY NOTES ---
	const clusters = findClusters(shapes)
	const clusteredIds = new Set(clusters.flatMap((c) => c.shapeIds))

	if (clusters.length > 0) {
		const clusterLines = clusters.map((cluster, i) => {
			const region = getRegionLabel(cluster.centroid)
			const members = cluster.shapeIds
				.map((id) => shapeById.get(id))
				.filter(Boolean) as CanvasShape[]
			const notes = members
				.map((s) => {
					const color = typeof s.props.color === 'string' ? ` (${s.props.color})` : ''
					return `  - [${s.id}] "${extractText(s)}"${color}`
				})
				.join('\n')
			return `Cluster ${i + 1} (${region}, ${members.length} items):\n${notes}`
		})
		sections.push(`SPATIAL CLUSTERS OF STICKY NOTES:\n\n${clusterLines.join('\n\n')}`)
	}

	// --- 3. ISOLATED STICKY NOTES ---
	const isolatedNotes = shapes.filter((s) => s.type === 'note' && !clusteredIds.has(s.id))
	if (isolatedNotes.length > 0) {
		const lines = isolatedNotes.map((s) => {
			const region = getRegionLabel(s)
			const color = typeof s.props.color === 'string' ? ` (${s.props.color})` : ''
			return `  - [${s.id}] "${extractText(s)}"${color} at ${region}`
		})
		sections.push(`ISOLATED STICKY NOTES:\n${lines.join('\n')}`)
	}

	// --- 4. GEO SHAPES ---
	const geoShapes = shapes.filter((s) => s.type === 'geo')
	if (geoShapes.length > 0) {
		const lines = geoShapes.map((s) => {
			const geo = s.props.geo ?? 'rectangle'
			const text = extractText(s)
			const region = getRegionLabel(s)
			const size = `${Math.round(Number(s.props.w ?? 0))}×${Math.round(Number(s.props.h ?? 0))}`
			const label = text ? ` "${text}"` : ''
			return `  - [${s.id}] ${geo}${label} ${size}px at ${region}`
		})
		sections.push(`GEO SHAPES:\n${lines.join('\n')}`)
	}

	// --- 5. TEXT BLOCKS ---
	const textShapes = shapes.filter((s) => s.type === 'text')
	if (textShapes.length > 0) {
		const lines = textShapes.map((s) => {
			const region = getRegionLabel(s)
			return `  - [${s.id}] "${extractText(s)}" at ${region}`
		})
		sections.push(`TEXT BLOCKS:\n${lines.join('\n')}`)
	}

	// --- 6. CONNECTIONS (arrows) ---
	// Each arrow has two bindings: terminal "start" → source shape, terminal "end" → target shape
	const arrowShapes = shapes.filter((s) => s.type === 'arrow')
	if (arrowShapes.length > 0) {
		const lines = arrowShapes.map((arrow) => {
			const arrowBindings = bindings.filter((b) => b.fromId === arrow.id)
			const startBinding = arrowBindings.find((b) => b.props.terminal === 'start')
			const endBinding = arrowBindings.find((b) => b.props.terminal === 'end')

			const sourceShape = startBinding ? shapeById.get(startBinding.toId) : undefined
			const targetShape = endBinding ? shapeById.get(endBinding.toId) : undefined

			const sourceLabel = sourceShape ? `"${extractText(sourceShape)}"` : '(unconnected)'
			const targetLabel = targetShape ? `"${extractText(targetShape)}"` : '(unconnected)'

			const arrowText = extractText(arrow)
			const labelPart = arrowText ? ` [label: "${arrowText}"]` : ''

			return `  - [${arrow.id}] ${sourceLabel} → ${targetLabel}${labelPart}`
		})
		sections.push(`CONNECTIONS (arrows):\n${lines.join('\n')}`)
	}

	// --- 7. DRAW SHAPES (freehand drawings) ---
	const drawShapes = shapes.filter((s) => s.type === 'draw')
	if (drawShapes.length > 0) {
		const lines = drawShapes.map((s) => {
			const region = getRegionLabel(s)
			const color = typeof s.props.color === 'string' ? s.props.color : 'default'
			const size = typeof s.props.size === 'string' ? s.props.size : 'm'
			const segments = Array.isArray(s.props.segments) ? s.props.segments : []
			const totalPoints = segments.reduce(
				(sum: number, seg: any) => sum + (Array.isArray(seg?.points) ? seg.points.length : 0),
				0
			)
			const complexity =
				totalPoints > 80
					? 'complex/detailed'
					: totalPoints > 30
						? 'moderate'
						: 'simple/quick'
			return `  - [${s.id}] freehand drawing (${complexity}, ${color}, stroke ${size}) at ${region}`
		})

		const nearbyText = findNearbyText(drawShapes, shapes)
		const contextLine = nearbyText.length > 0
			? `\n  Context from nearby text: ${nearbyText.join('; ')}`
			: ''
		sections.push(`FREEHAND DRAWINGS:\n${lines.join('\n')}${contextLine}`)
	}

	// --- 8. IMAGE SHAPES ---
	const imageShapes = shapes.filter((s) => s.type === 'image')
	if (imageShapes.length > 0) {
		const lines = imageShapes.map((s) => {
			const region = getRegionLabel(s)
			const w = Math.round(Number(s.props.w ?? 0))
			const h = Math.round(Number(s.props.h ?? 0))
			return `  - [${s.id}] image ${w}×${h}px at ${region}`
		})
		sections.push(`IMAGES:\n${lines.join('\n')}`)
	}

	// --- 9. FRAMES ---
	const frameShapes = shapes.filter((s) => s.type === 'frame')
	if (frameShapes.length > 0) {
		const lines = frameShapes.map((frame) => {
			const children = shapes.filter((s) => s.parentId === frame.id)
			return `  - [${frame.id}] "${extractText(frame)}": contains ${children.length} elements`
		})
		sections.push(`FRAMES:\n${lines.join('\n')}`)
	}

	// --- 10. GROUPS ---
	const groupShapes = shapes.filter((s) => s.type === 'group')
	if (groupShapes.length > 0) {
		const lines = groupShapes.map((group) => {
			const children = shapes.filter((s) => s.parentId === group.id)
			const region = getRegionLabel(group)
			const childLines = children
				.map((c) => `      [${c.id}] ${c.type} "${extractText(c)}"`)
				.join('\n')
			return `  - [${group.id}] group at ${region}\n${childLines || '      (empty)'}`
		})
		sections.push(`GROUPS:\n${lines.join('\n\n')}`)
	}

	return sections.join('\n\n')
}
