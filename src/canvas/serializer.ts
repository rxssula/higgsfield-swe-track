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
// Serializer
// ---------------------------------------------------------------------------

export function serializeCanvasState(snapshot: CanvasSnapshot): string {
	const { shapes, bindings } = snapshot
	const sections: string[] = []

	// Build lookup maps used across sections
	const shapeById = new Map(shapes.map((s) => [s.id, s]))

	// --- 1. CANVAS OVERVIEW ---
	const counts: Record<string, number> = {}
	for (const s of shapes) counts[s.type] = (counts[s.type] ?? 0) + 1
	const overviewLines = Object.entries(counts)
		.map(([type, n]) => `  ${type}: ${n}`)
		.join('\n')
	sections.push(`## CANVAS OVERVIEW\nTotal shapes: ${shapes.length}\n${overviewLines}`)

	// --- 2. SPATIAL CLUSTERS ---
	const clusters = findClusters(shapes)
	const clusteredIds = new Set(clusters.flatMap((c) => c.shapeIds))

	if (clusters.length > 0) {
		const clusterLines = clusters.map((cluster, i) => {
			const region = getRegionLabel(cluster.centroid)
			const members = cluster.shapeIds
				.map((id) => shapeById.get(id))
				.filter(Boolean) as CanvasShape[]
			const notes = members
				.map((s) => `    - [${s.id}] "${extractText(s)}"`)
				.join('\n')
			return `  Cluster ${i + 1} (${region}, ${members.length} notes):\n${notes}`
		})
		sections.push(`## SPATIAL CLUSTERS\n${clusterLines.join('\n\n')}`)
	} else {
		sections.push(`## SPATIAL CLUSTERS\n  (none)`)
	}

	// --- 3. ISOLATED NOTES ---
	const isolatedNotes = shapes.filter((s) => s.type === 'note' && !clusteredIds.has(s.id))
	if (isolatedNotes.length > 0) {
		const lines = isolatedNotes.map((s) => {
			const region = getRegionLabel(s)
			return `  - [${s.id}] "${extractText(s)}" at ${region}`
		})
		sections.push(`## ISOLATED NOTES\n${lines.join('\n')}`)
	} else {
		sections.push(`## ISOLATED NOTES\n  (none)`)
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
		sections.push(`## GEO SHAPES\n${lines.join('\n')}`)
	} else {
		sections.push(`## GEO SHAPES\n  (none)`)
	}

	// --- 5. TEXT BLOCKS ---
	const textShapes = shapes.filter((s) => s.type === 'text')
	if (textShapes.length > 0) {
		const lines = textShapes.map((s) => {
			const region = getRegionLabel(s)
			return `  - [${s.id}] "${extractText(s)}" at ${region}`
		})
		sections.push(`## TEXT BLOCKS\n${lines.join('\n')}`)
	} else {
		sections.push(`## TEXT BLOCKS\n  (none)`)
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

			const sourceLabel = sourceShape
				? `"${extractText(sourceShape)}" [${sourceShape.id}]`
				: '(unconnected)'
			const targetLabel = targetShape
				? `"${extractText(targetShape)}" [${targetShape.id}]`
				: '(unconnected)'

			const arrowText = extractText(arrow)
			const labelPart = arrowText ? ` (label: "${arrowText}")` : ''

			return `  - [${arrow.id}]${labelPart} ${sourceLabel} → ${targetLabel}`
		})
		sections.push(`## CONNECTIONS\n${lines.join('\n')}`)
	} else {
		sections.push(`## CONNECTIONS\n  (none)`)
	}

	// --- 7. FRAMES ---
	const frameShapes = shapes.filter((s) => s.type === 'frame')
	if (frameShapes.length > 0) {
		const lines = frameShapes.map((frame) => {
			const children = shapes.filter((s) => s.parentId === frame.id)
			const region = getRegionLabel(frame)
			const size = `${Math.round(Number(frame.props.w ?? 0))}×${Math.round(Number(frame.props.h ?? 0))}`
			const childLines = children
				.map((c) => `      [${c.id}] ${c.type} "${extractText(c)}"`)
				.join('\n')
			return `  - [${frame.id}] "${extractText(frame)}" ${size}px at ${region}\n${childLines || '      (empty)'}`
		})
		sections.push(`## FRAMES\n${lines.join('\n\n')}`)
	} else {
		sections.push(`## FRAMES\n  (none)`)
	}

	// --- 8. GROUPS ---
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
		sections.push(`## GROUPS\n${lines.join('\n\n')}`)
	} else {
		sections.push(`## GROUPS\n  (none)`)
	}

	return sections.join('\n\n')
}
