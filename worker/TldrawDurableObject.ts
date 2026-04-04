import { DurableObjectSqliteSyncWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import {
	createTLSchema,
	// defaultBindingSchemas,
	defaultShapeSchemas,
	TLRecord,
} from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error, IRequest } from 'itty-router'
import { serializeCanvasState } from '../src/canvas/serializer'
import type { CanvasSnapshot } from '../src/canvas/types'
import { invokeAgent } from '../src/agent/claude'
import { submitGeneration, pollUntilDone } from '../src/higgsfield/client'

// add custom shapes and bindings here if needed:
const schema = createTLSchema({
	shapes: { ...defaultShapeSchemas },
	// bindings: { ...defaultBindingSchemas },
})

// Each whiteboard room is hosted in a Durable Object.
// https://developers.cloudflare.com/durable-objects/
//
// There's only ever one durable object instance per room. Room state is
// persisted automatically to SQLite via ctx.storage.
export class TldrawDurableObject extends DurableObject<Env> {
	private room: TLSocketRoom<TLRecord, void>

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		// Create SQLite-backed storage - persists automatically to Durable Object storage
		const sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
		const storage = new SQLiteSyncStorage<TLRecord>({ sql })

		// Create the room that handles sync protocol
		this.room = new TLSocketRoom<TLRecord, void>({ schema, storage })
	}

	private readonly router = AutoRouter({ catch: (e) => error(e) })
		.get('/api/connect/:roomId', (request) => this.handleConnect(request))
		.post('/api/agent/run', (request) => this.handleAgentRun(request))

	// Entry point for all requests to the Durable Object
	fetch(request: Request): Response | Promise<Response> {
		return this.router.fetch(request)
	}

	// Handle new WebSocket connection requests
	async handleConnect(request: IRequest) {
		const sessionId = request.query.sessionId as string
		if (!sessionId) return error(400, 'Missing sessionId')

		// Create the websocket pair for the client
		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		serverWebSocket.accept()

		// Connect to the room
		this.room.handleSocketConnect({ sessionId, socket: serverWebSocket })

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	// Receives the agent invocation from worker.ts, kicks off the pipeline
	// async and returns immediately — results are pushed via WebSocket.
	async handleAgentRun(request: IRequest) {
		console.log('[handleAgentRun] received')
		const body = await request.json() as {
			shapes: unknown[]
			bindings: unknown[]
			message?: string
			mode?: string
		}

		this.ctx.waitUntil(
			this.runAgentPipeline(body.shapes, body.bindings, body.message, body.mode)
		)

		return Response.json({ ok: true })
	}

	// Broadcasts a message to every connected session in the room.
	private broadcast(data: object) {
		for (const session of this.room.getSessions()) {
			this.room.sendCustomMessage(session.sessionId, data)
		}
	}

	// Runs the full agent pipeline: serialize → Claude → Higgsfield → broadcast result.
	private async runAgentPipeline(
		shapes: unknown[],
		bindings: unknown[],
		message?: string,
		_mode?: string
	) {
		console.log('[pipeline] start, shapes:', shapes.length)
		try {
			this.broadcast({ type: 'agent:status', status: 'Reading canvas...' })
			const snapshot: CanvasSnapshot = { shapes: shapes as any, bindings: bindings as any }
			const serialized = serializeCanvasState(snapshot)
			console.log('[pipeline] serialized canvas:\n', serialized)

			this.broadcast({ type: 'agent:status', status: 'Generating prompt...' })
			const replyRaw = await invokeAgent(
				this.env.OPENROUTER_API_KEY,
				this.env.OPENROUTER_MODEL,
				serialized,
				message
			)
			console.log('[pipeline] claude reply:', replyRaw)
			// Extract JSON even if Claude wraps it in markdown code fences or prose
			const jsonMatch = replyRaw.match(/\{[\s\S]*\}/)
			if (!jsonMatch) throw new Error(`Claude did not return JSON: ${replyRaw}`)
			const { synthesis, prompt } = JSON.parse(jsonMatch[0])

			this.broadcast({ type: 'agent:status', status: 'Rendering image...' })
			const requestId = await submitGeneration(
				this.env.HIGGSFIELD_API_KEY,
				this.env.HIGGSFIELD_API_SECRET,
				this.env.HIGGSFIELD_MODEL,
				prompt
			)
			console.log('[pipeline] higgsfield requestId:', requestId)
			const imageUrl = await pollUntilDone(
				this.env.HIGGSFIELD_API_KEY,
				this.env.HIGGSFIELD_API_SECRET,
				requestId
			)
			console.log('[pipeline] done, imageUrl:', imageUrl)

			this.broadcast({ type: 'agent:done', imageUrl, synthesis, prompt })
		} catch (e) {
			console.error('[pipeline] error:', e)
			this.broadcast({ type: 'agent:error', message: String(e) })
		}
	}
}
