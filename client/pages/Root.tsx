import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { uniqueId } from 'tldraw'

export function Root() {
    const navigate = useNavigate()
    const [joinId, setJoinId] = useState('')

    const handleCreate = () => {
        const roomId = 'room-' + uniqueId()
        navigate(`/${roomId}`)
    }

    const handleJoin = (e: React.FormEvent) => {
        e.preventDefault()
        if (joinId.trim()) {
            navigate(`/${joinId.trim()}`)
        }
    }

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center relative overflow-hidden selection:bg-[#c8ff00]/30">
            {/* Ambient glow effects */}
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#c8ff00]/5 rounded-full blur-[120px] pointer-events-none" />
            <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-[#c8ff00]/3 rounded-full blur-[100px] pointer-events-none" />

            {/* Floating decorative cards */}
            <div className="absolute top-[15%] left-[8%] w-32 h-40 rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm rotate-[-12deg] hidden lg:block" />
            <div className="absolute top-[20%] right-[10%] w-28 h-36 rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm rotate-[8deg] hidden lg:block" />
            <div className="absolute bottom-[18%] left-[12%] w-24 h-32 rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm rotate-[15deg] hidden lg:block" />
            <div className="absolute bottom-[25%] right-[8%] w-36 h-28 rounded-2xl border border-[#c8ff00]/10 bg-[#c8ff00]/[0.02] backdrop-blur-sm rotate-[-6deg] hidden lg:block" />

            {/* Grid pattern overlay */}
            <div
                className="absolute inset-0 pointer-events-none opacity-[0.03]"
                style={{
                    backgroundImage: `linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)`,
                    backgroundSize: '60px 60px',
                }}
            />

            {/* Main content */}
            <div className="relative z-10 flex flex-col items-center px-6 max-w-lg w-full">
                {/* Logo / Brand */}
                <div className="mb-12 flex flex-col items-center gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#c8ff00] to-[#a0cc00] flex items-center justify-center shadow-[0_0_40px_rgba(200,255,0,0.2)]">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 19l7-7 3 3-7 7-3-3z" />
                            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                            <path d="M2 2l7.586 7.586" />
                            <circle cx="11" cy="11" r="2" />
                        </svg>
                    </div>
                    <h1 className="text-5xl sm:text-6xl font-bold tracking-tight text-center text-white">
                        10x VIBERS
                    </h1>
                    <p className="text-white/40 text-center text-base max-w-sm">
                        Create a room, share the link, and draw together in real-time
                    </p>
                </div>

                {/* Create Room Button */}
                <button
                    onClick={handleCreate}
                    className="w-full group relative mb-6 cursor-pointer"
                >
                    <div className="absolute inset-0 bg-[#c8ff00] rounded-2xl blur-md opacity-20 group-hover:opacity-40 transition-opacity duration-300" />
                    <div className="relative bg-[#c8ff00] text-[#0a0a0a] font-bold text-lg py-4 px-8 rounded-2xl flex items-center justify-center gap-3 transition-all duration-200 group-hover:shadow-[0_0_30px_rgba(200,255,0,0.3)] group-active:scale-[0.98]">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Create New Room
                        <span className="text-[#0a0a0a]/50 text-sm font-medium ml-1">
                            &#x2728;
                        </span>
                    </div>
                </button>

                {/* Divider */}
                <div className="flex items-center gap-4 w-full mb-6">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-white/20 text-xs uppercase tracking-widest">or join</span>
                    <div className="flex-1 h-px bg-white/10" />
                </div>

                {/* Join Room */}
                <form onSubmit={handleJoin} className="w-full flex gap-3">
                    <input
                        type="text"
                        value={joinId}
                        onChange={(e) => setJoinId(e.target.value)}
                        placeholder="Paste room ID or link..."
                        className="flex-1 bg-white/[0.05] border border-white/10 rounded-xl px-5 py-3.5 text-white placeholder-white/25 outline-none focus:border-[#c8ff00]/40 focus:bg-white/[0.07] transition-all duration-200 text-sm"
                    />
                    <button
                        type="submit"
                        disabled={!joinId.trim()}
                        className="bg-white/[0.07] border border-white/10 hover:border-[#c8ff00]/30 text-white/70 hover:text-[#c8ff00] disabled:opacity-30 disabled:cursor-not-allowed px-5 rounded-xl transition-all duration-200 cursor-pointer text-sm font-medium"
                    >
                        Join
                    </button>
                </form>

                {/* Keyboard hint */}
                <div className="mt-16 flex items-center gap-2 text-white/15 text-xs">
                    <kbd className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-[10px]">Enter</kbd>
                    <span>to join</span>
                </div>
            </div>

            {/* Bottom subtle branding */}
            <div className="absolute bottom-6 text-white/10 text-xs tracking-wider">
                BUILT FOR HACKNU 2026
            </div>
        </div>
    )
}
