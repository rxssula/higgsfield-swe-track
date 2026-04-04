// Constants that don't depend on runtime env.
// Secrets (ANTHROPIC_API_KEY, HIGGSFIELD_API_KEY) come from the `env` parameter
// passed to each Cloudflare Worker handler — there is no process.env here.

export const CLAUDE_MODEL = 'claude-sonnet-4-6'
export const CLAUDE_MAX_TOKENS = 4096

// Proactive agent intervals per mode (ms)
export const PROACTIVE_INTERVAL = {
	observer: Infinity,
	collaborator: 45_000,
	facilitator: 25_000,
} as const

// How many messages to keep in session history
export const SESSION_HISTORY_MAX = 50
export const SESSION_HISTORY_TRIM_TO = 30
export const SESSION_HISTORY_WINDOW = 20 // messages sent to Claude per call

// Spatial clustering threshold (px) — tldraw notes are ~200px wide
export const CLUSTER_THRESHOLD_PX = 300
