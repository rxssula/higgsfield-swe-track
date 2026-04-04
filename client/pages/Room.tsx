import { useSync } from '@tldraw/sync'
import { ReactNode, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Tldraw } from 'tldraw'
import { getBookmarkPreview } from '../getBookmarkPreview'
import { multiplayerAssetStore } from '../multiplayerAssetStore'

type AgentState =
    | { status: 'idle' }
    | { status: 'working'; message: string }
    | { status: 'done'; imageUrl: string; synthesis: string }
    | { status: 'error'; message: string }

export function Room() {
    const { roomId } = useParams<{ roomId: string }>()
    const [agentState, setAgentState] = useState<AgentState>({ status: 'idle' })

    // Create a store connected to multiplayer.
    const store = useSync({
        // We need to know the websockets URI...
        uri: `${window.location.origin}/api/connect/${roomId}`,
        // ...and how to handle static assets like images & videos
        assets: multiplayerAssetStore,
        onCustomMessageReceived: (data: any) => {
            if (data.type === 'agent:status') {
                setAgentState({ status: 'working', message: data.status })
            } else if (data.type === 'agent:done') {
                setAgentState({ status: 'done', imageUrl: data.imageUrl, synthesis: data.synthesis })
            } else if (data.type === 'agent:error') {
                setAgentState({ status: 'error', message: data.message })
            }
        },
    })

    return (
        <RoomWrapper roomId={roomId} agentState={agentState} onAgentDismiss={() => setAgentState({ status: 'idle' })}>
            <Tldraw
                // we can pass the connected store into the Tldraw component which will handle
                // loading states & enable multiplayer UX like cursors & a presence menu
                licenseKey='tldraw-2026-07-13/WyJGSFVscnJvLSIsWyIqIl0sMTYsIjIwMjYtMDctMTMiXQ.ffAi96kEDbYvfzuY4Xc/RMVMdarp1OrXCVWE4vls8eJkZb+PdYIDEWffxFYCYEhoeCKSCn0nM2RsbS/q5DwFzg'
                store={store}
                options={{ deepLinks: true }}
                onMount={(editor) => {
                    // default to dark theme to match site aesthetic — user can still toggle
                    const prefs = editor.user.getUserPreferences()
                    if (!prefs.colorScheme || prefs.colorScheme === 'light') {
                        editor.user.updateUserPreferences({ colorScheme: 'dark' })
                    }
                    // when the editor is ready, we need to register our bookmark unfurling service
                    editor.registerExternalAssetHandler('url', getBookmarkPreview)
                }}
            />
        </RoomWrapper>
    )
}

function RoomWrapper({ children, roomId, agentState, onAgentDismiss }: { children: ReactNode; roomId?: string; agentState: AgentState; onAgentDismiss: () => void }) {
    const [didCopy, setDidCopy] = useState(false)
    const navigate = useNavigate()

    useEffect(() => {
        if (!didCopy) return
        const timeout = setTimeout(() => setDidCopy(false), 3000)
        return () => clearTimeout(timeout)
    }, [didCopy])

    return (
        <div className="room-shell">
            {/* Header bar */}
            <div className="room-header">
                {/* Left: back + brand */}
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => navigate('/')}
                        className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/10 flex items-center justify-center text-white/50 hover:text-[#c8ff00] hover:border-[#c8ff00]/30 transition-all duration-200 cursor-pointer"
                        aria-label="Back to home"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 12H5" />
                            <path d="M12 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-md bg-gradient-to-br from-[#c8ff00] to-[#a0cc00] flex items-center justify-center shadow-[0_0_12px_rgba(200,255,0,0.15)]">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                                <path d="M2 2l7.586 7.586" />
                                <circle cx="11" cy="11" r="2" />
                            </svg>
                        </div>
                        <span className="text-sm font-bold tracking-tight">
                            <span className="text-white">COLLAB</span>
                            <span className="text-[#c8ff00]">DRAW</span>
                        </span>
                    </div>
                </div>

                {/* Center: room id with live indicator */}
                <div className="flex items-center gap-2.5">
                    <div className="room-live-dot" />
                    <span className="text-white/40 text-xs font-medium tracking-wide truncate max-w-[200px] sm:max-w-[300px]">
                        {roomId}
                    </span>
                </div>

                {/* Right: copy link */}
                <button
                    className="room-copy-btn group"
                    onClick={() => {
                        navigator.clipboard.writeText(window.location.href)
                        setDidCopy(true)
                    }}
                    aria-label="copy room link"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 group-hover:text-[#c8ff00] transition-colors duration-200">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span className="text-xs font-medium text-white/50 group-hover:text-[#c8ff00] transition-colors duration-200">
                        {didCopy ? 'Copied!' : 'Copy link'}
                    </span>
                </button>
            </div>

            {/* Agent status overlay */}
            {agentState.status !== 'idle' && (
                <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-white/10 bg-[#111] p-4 shadow-2xl">
                    {agentState.status === 'working' && (
                        <div className="flex items-center gap-3 text-white/70 text-sm">
                            <div className="h-2 w-2 rounded-full bg-[#c8ff00] animate-pulse" />
                            {agentState.message}
                        </div>
                    )}
                    {agentState.status === 'done' && (
                        <div className="flex flex-col gap-2">
                            <img src={agentState.imageUrl} alt="Generated" className="rounded-lg w-full" />
                            <p className="text-white/50 text-xs">{agentState.synthesis}</p>
                            <button
                                onClick={onAgentDismiss}
                                className="text-xs text-white/30 hover:text-white/60 transition-colors self-end"
                            >
                                dismiss
                            </button>
                        </div>
                    )}
                    {agentState.status === 'error' && (
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-red-400 text-sm">{agentState.message}</p>
                            <button
                                onClick={onAgentDismiss}
                                className="text-xs text-white/30 hover:text-white/60 transition-colors"
                            >
                                dismiss
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Canvas */}
            <div className="room-canvas">{children}</div>
        </div>
    )
}
