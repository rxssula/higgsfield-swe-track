import { DurableObjectSqliteSyncWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import {
	createTLSchema,
	// defaultBindingSchemas,
	defaultShapeSchemas,
	TLRecord,
} from '@tldraw/tlschema'
import { DurableObject } from 'cloudflare:workers'
import { AutoRouter, error, IRequest } from 'itty-router'

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
export class TldrawDurableObject extends DurableObject {
	private room: TLSocketRoom<TLRecord, void>
	private voiceSessions = new Map<string, WebSocket>()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		const sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
		const storage = new SQLiteSyncStorage<TLRecord>({ sql })
		this.room = new TLSocketRoom<TLRecord, void>({ schema, storage })
	}

	private readonly router = AutoRouter({ catch: (e) => error(e) })
		.get('/api/connect/:roomId', (request) => this.handleConnect(request))
		.get('/api/voice/:roomId', (request) => this.handleVoiceConnect(request))

	fetch(request: Request): Response | Promise<Response> {
		return this.router.fetch(request)
	}

	async handleConnect(request: IRequest) {
		const sessionId = request.query.sessionId as string
		if (!sessionId) return error(400, 'Missing sessionId')

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		serverWebSocket.accept()
		this.room.handleSocketConnect({ sessionId, socket: serverWebSocket })

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	// ── Voice chat signaling ──

	async handleVoiceConnect(request: IRequest) {
		const sessionId = request.query.sessionId as string
		if (!sessionId) return error(400, 'Missing sessionId')

		const { 0: clientWebSocket, 1: serverWebSocket } = new WebSocketPair()
		serverWebSocket.accept()

		const currentPeers = Array.from(this.voiceSessions.keys())
		serverWebSocket.send(
			JSON.stringify({ type: 'voice-peers', peers: currentPeers }),
		)

		this.voiceSessions.set(sessionId, serverWebSocket)
		this.broadcastVoice({ type: 'voice-join', sessionId }, sessionId)

		serverWebSocket.addEventListener('message', (event) => {
			try {
				const msg = JSON.parse(event.data as string)

				if (msg.type === 'voice-leave') {
					this.voiceSessions.delete(sessionId)
					this.broadcastVoice({ type: 'voice-leave', sessionId })
					serverWebSocket.close()
					return
				}

				if (msg.to) {
					const target = this.voiceSessions.get(msg.to)
					if (target && target.readyState === 1) {
						target.send(JSON.stringify(msg))
					}
				}
			} catch {
				/* ignore malformed messages */
			}
		})

		serverWebSocket.addEventListener('close', () => {
			this.voiceSessions.delete(sessionId)
			this.broadcastVoice({ type: 'voice-leave', sessionId })
		})

		serverWebSocket.addEventListener('error', () => {
			this.voiceSessions.delete(sessionId)
			this.broadcastVoice({ type: 'voice-leave', sessionId })
		})

		return new Response(null, { status: 101, webSocket: clientWebSocket })
	}

	private broadcastVoice(msg: object, excludeId?: string) {
		const data = JSON.stringify(msg)
		for (const [id, socket] of this.voiceSessions) {
			if (id === excludeId) continue
			if (socket.readyState === 1) {
				socket.send(data)
			}
		}
	}
}
