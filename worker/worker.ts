import { handleUnfurlRequest } from 'cloudflare-workers-unfurl'
import { AutoRouter, error, IRequest } from 'itty-router'
import { handleAssetDownload, handleAssetUpload } from './assetUploads'

// make sure our sync durable object is made available to cloudflare
export { TldrawDurableObject } from './TldrawDurableObject'

// we use itty-router (https://itty.dev/) to handle routing. in this example we turn on CORS because
// we're hosting the worker separately to the client. you should restrict this to your own domain.
const router = AutoRouter<IRequest, [env: Env, ctx: ExecutionContext]>({
	catch: (e) => {
		console.error(e)
		return error(e)
	},
})
	// requests to /connect are routed to the Durable Object, and handle realtime websocket syncing
	.get('/api/connect/:roomId', (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})

	// voice chat signaling — same DO per room so all voice peers meet in the same instance
	.get('/api/voice/:roomId', (request, env) => {
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(request.params.roomId)
		const room = env.TLDRAW_DURABLE_OBJECT.get(id)
		return room.fetch(request.url, { headers: request.headers, body: request.body })
	})

	// assets can be uploaded to the bucket under /uploads:
	.post('/api/uploads/:uploadId', handleAssetUpload)

	// they can be retrieved from the bucket too:
	.get('/api/uploads/:uploadId', handleAssetDownload)

	// bookmarks need to extract metadata from pasted URLs:
	.get('/api/unfurl', handleUnfurlRequest)

	// --- Agent routes ---
	// Frontend POSTs here to invoke the agent for a specific room.
	// The agent runs Claude, then pushes actions back to all clients in the room
	// via TLSocketRoom.sendCustomMessage() (see TldrawDurableObject.ts).
	.post('/api/rooms/:roomId/agent/invoke', async (request, env) => {
		const { roomId } = request.params
		if (!roomId) return error(400, 'Missing roomId')

		const body = await request.json().catch(() => null)
		if (!body || typeof body !== 'object') return error(400, 'Invalid JSON body')

		const { message, shapes, bindings, mode } = body as {
			message?: string
			shapes?: unknown[]
			bindings?: unknown[]
			mode?: string
		}

		if (!Array.isArray(shapes)) return error(400, 'Missing shapes array')
		if (!Array.isArray(bindings)) return error(400, 'Missing bindings array')

		// Forward to the Durable Object — it runs the pipeline and broadcasts
		// progress + result to all connected clients via WebSocket.
		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(roomId)
		const stub = env.TLDRAW_DURABLE_OBJECT.get(id)
		await stub.fetch(new Request('https://do/api/agent/run', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ shapes, bindings, message, mode }),
		}))

		return Response.json({ ok: true })
	})

	// Frontend POSTs here to switch the agent's behavior mode for a room.
	.post('/api/rooms/:roomId/agent/set-mode', async (request) => {
		const { roomId } = request.params
		if (!roomId) return error(400, 'Missing roomId')

		const body = await request.json().catch(() => null)
		if (!body || typeof body !== 'object') return error(400, 'Invalid JSON body')

		const { mode } = body as { mode?: string }
		const validModes = ['observer', 'collaborator', 'facilitator']
		if (!mode || !validModes.includes(mode)) {
			return error(400, `Invalid mode. Must be one of: ${validModes.join(', ')}`)
		}

		// TODO (Milestone 5): update AgentEngine mode for this room, broadcast
		// agent:mode-changed via TldrawDurableObject.sendCustomMessage()
		console.log(`[agent:set-mode] room=${roomId} mode=${mode}`)

		return Response.json({ ok: true, mode })
	})

	// Takes a base64 canvas screenshot, forwards to the Durable Object which
	// runs Claude Vision → Higgsfield and broadcasts results via WebSocket.
	.post('/api/rooms/:roomId/agent/brainstorm', async (request, env) => {
		const { roomId } = request.params
		if (!roomId) return error(400, 'Missing roomId')

		const body = await request.json().catch(() => null)
		if (!body || typeof body !== 'object') return error(400, 'Invalid JSON body')

		const { image, mimeType } = body as { image?: string; mimeType?: string }
		if (!image) return error(400, 'Missing image (base64)')
		if (!mimeType) return error(400, 'Missing mimeType')

		console.log(`[agent:brainstorm] room=${roomId}`)

		const id = env.TLDRAW_DURABLE_OBJECT.idFromName(roomId)
		const stub = env.TLDRAW_DURABLE_OBJECT.get(id)
		await stub.fetch(new Request('https://do/api/agent/brainstorm', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image, mimeType }),
		}))

		return Response.json({ ok: true })
	})

	.all('*', () => {
		return new Response('Not found', { status: 404 })
	})

export default {
	fetch: router.fetch,
}
