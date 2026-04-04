import type { CanvasShape } from './types'
import { CLUSTER_THRESHOLD_PX } from '../config'

export interface Cluster {
	shapeIds: string[]
	centroid: { x: number; y: number }
}

// Maps raw canvas coordinates to a human-readable quadrant label.
// tldraw uses an infinite canvas — no fixed dimensions, so we use the
// coordinate origin as the reference point instead of percentages.
export function getRegionLabel(point: { x: number; y: number }): string {
	const xLabel = point.x < 0 ? 'left' : 'right'
	const yLabel = point.y < 0 ? 'top' : 'bottom'
	return `${yLabel}-${xLabel} (${Math.round(point.x)}, ${Math.round(point.y)})`
}

// Euclidean distance between two shape center points.
function distance(a: CanvasShape, b: CanvasShape): number {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return Math.sqrt(dx * dx + dy * dy)
}

// Groups note shapes that are within `threshold` px of each other.
// Uses greedy expansion: seed from each unvisited note, repeatedly pull in
// any note within threshold of any current cluster member.
// Only returns clusters with ≥2 members.
export function findClusters(
	shapes: CanvasShape[],
	threshold = CLUSTER_THRESHOLD_PX
): Cluster[] {
	const notes = shapes.filter((s) => s.type === 'note')
	const visited = new Set<string>()
	const clusters: Cluster[] = []

	for (const seed of notes) {
		if (visited.has(seed.id)) continue

		// Start a new cluster from this seed
		const members: CanvasShape[] = [seed]
		visited.add(seed.id)

		// Expand: keep scanning until no new members are added
		let changed = true
		while (changed) {
			changed = false
			for (const candidate of notes) {
				if (visited.has(candidate.id)) continue
				const inRange = members.some((m) => distance(m, candidate) <= threshold)
				if (inRange) {
					members.push(candidate)
					visited.add(candidate.id)
					changed = true
				}
			}
		}

		if (members.length < 2) continue

		const centroid = {
			x: members.reduce((sum, s) => sum + s.x, 0) / members.length,
			y: members.reduce((sum, s) => sum + s.y, 0) / members.length,
		}

		clusters.push({ shapeIds: members.map((s) => s.id), centroid })
	}

	return clusters
}
