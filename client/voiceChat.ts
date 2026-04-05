// Web Speech API types (not always in TS DOM lib)
interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
    readonly transcript: string;
    readonly confidence: number;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventMap {
    result: { resultIndex: number; results: SpeechRecognitionResultList };
    end: Event;
    error: { error: string };
}
interface ISpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((ev: SpeechRecognitionEventMap["result"]) => void) | null;
    onend: ((ev: Event) => void) | null;
    onerror: ((ev: SpeechRecognitionEventMap["error"]) => void) | null;
}

type SignalMessage =
    | { type: "voice-join"; sessionId: string; username?: string }
    | { type: "voice-leave"; sessionId: string }
    | { type: "voice-peers"; peers: string[]; peerDetails?: { sessionId: string; username: string }[] }
    | { type: "voice-mute-status"; sessionId: string; muted: boolean }
    | {
          type: "voice-offer";
          from: string;
          to: string;
          offer: RTCSessionDescriptionInit;
      }
    | {
          type: "voice-answer";
          from: string;
          to: string;
          answer: RTCSessionDescriptionInit;
      }
    | {
          type: "voice-ice";
          from: string;
          to: string;
          candidate: RTCIceCandidateInit;
      };

const ICE_SERVERS: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
];

export type PeerInfo = {
    sessionId: string;
    shortId: string;
    username: string;
    muted: boolean;
    speaking: boolean;
};

export type VoiceState = {
    joined: boolean;
    muted: boolean;
    peerCount: number;
    listening: boolean;
    lastTranscript: string;
    peers: Map<string, PeerInfo>;
    selfSpeaking: boolean;
};

type VoiceStateListener = (state: VoiceState) => void;

const SPEAKING_THRESHOLD = 15;
const SPEAKING_HOLDOVER_MS = 200;
const VAD_INTERVAL_MS = 50;

export class VoiceChatManager {
    private ws: WebSocket | null = null;
    private sessionId: string;
    private roomId: string;
    private localStream: MediaStream | null = null;
    private peerConnections = new Map<string, RTCPeerConnection>();
    private audioElements = new Map<string, HTMLAudioElement>();
    private recognition: ISpeechRecognition | null = null;
    private state: VoiceState = {
        joined: false,
        muted: false,
        peerCount: 0,
        listening: false,
        lastTranscript: "",
        peers: new Map(),
        selfSpeaking: false,
    };
    private listeners = new Set<VoiceStateListener>();
    private triggerWord: string;
    private onCommand: ((command: string) => void) | null = null;
    private speechRetries = 0;
    private static MAX_SPEECH_RETRIES = 3;
    private username: string;

    // VAD
    private audioContext: AudioContext | null = null;
    private localAnalyser: AnalyserNode | null = null;
    private remoteAnalysers = new Map<string, AnalyserNode>();
    private vadInterval: ReturnType<typeof setInterval> | null = null;
    private selfSpeakingUntil = 0;
    private peerSpeakingUntil = new Map<string, number>();

    constructor(
        roomId: string,
        opts?: {
            triggerWord?: string;
            onCommand?: (command: string) => void;
            username?: string;
        },
    ) {
        this.roomId = roomId;
        this.sessionId = "v-" + crypto.randomUUID().slice(0, 8);
        this.triggerWord = (opts?.triggerWord ?? "jose").toLowerCase();
        this.onCommand = opts?.onCommand ?? null;
        this.username = opts?.username ?? "";
    }

    getUsername() {
        return this.username;
    }

    getSessionId() {
        return this.sessionId;
    }

    getState() {
        return this.state;
    }

    subscribe(listener: VoiceStateListener) {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private setState(partial: Partial<VoiceState>) {
        this.state = { ...this.state, ...partial };
        this.listeners.forEach((l) => l(this.state));
    }

    private updatePeers(fn: (peers: Map<string, PeerInfo>) => void) {
        const next = new Map(this.state.peers);
        fn(next);
        this.setState({ peers: next, peerCount: next.size });
    }

    async join() {
        if (this.state.joined) return;

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
                video: false,
            });
        } catch (err) {
            console.error("Microphone access denied:", err);
            throw err;
        }

        this.setupLocalVAD();

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/voice/${this.roomId}?sessionId=${this.sessionId}`;
        this.ws = new WebSocket(url);

        this.ws.onmessage = (ev) => {
            const msg: SignalMessage = JSON.parse(ev.data);
            this.handleSignal(msg);
        };

        this.ws.onopen = () => {
            this.send({
                type: "voice-join",
                sessionId: this.sessionId,
                username: this.username,
            });
            this.setState({ joined: true });
            this.send({
                type: "voice-mute-status",
                sessionId: this.sessionId,
                muted: this.state.muted,
            });
            this.startSpeechRecognition();
        };

        this.ws.onclose = () => this.cleanup();

        this.ws.onerror = () => this.cleanup();
    }

    leave() {
        if (!this.state.joined) return;
        this.send({ type: "voice-leave", sessionId: this.sessionId });
        this.cleanup();
    }

    toggleMute() {
        if (!this.localStream) return;
        const track = this.localStream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        const muted = !track.enabled;
        this.setState({ muted });
        this.send({
            type: "voice-mute-status",
            sessionId: this.sessionId,
            muted,
        });
    }

    private send(msg: SignalMessage) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private makePeerInfo(peerId: string, username?: string): PeerInfo {
        return {
            sessionId: peerId,
            shortId: peerId.replace(/^v-/, ""),
            username: username ?? peerId.replace(/^v-/, ""),
            muted: false,
            speaking: false,
        };
    }

    private async handleSignal(msg: SignalMessage) {
        switch (msg.type) {
            case "voice-peers": {
                const detailsMap = new Map<string, string>();
                if (msg.peerDetails) {
                    for (const d of msg.peerDetails) {
                        detailsMap.set(d.sessionId, d.username);
                    }
                }
                for (const peerId of msg.peers) {
                    await this.createPeerConnection(peerId, true);
                }
                this.updatePeers((peers) => {
                    for (const peerId of msg.peers) {
                        if (!peers.has(peerId)) {
                            peers.set(peerId, this.makePeerInfo(peerId, detailsMap.get(peerId)));
                        }
                    }
                });
                break;
            }
            case "voice-join": {
                if (msg.sessionId !== this.sessionId) {
                    this.updatePeers((peers) => {
                        if (!peers.has(msg.sessionId)) {
                            peers.set(
                                msg.sessionId,
                                this.makePeerInfo(msg.sessionId, msg.username),
                            );
                        }
                    });
                }
                break;
            }
            case "voice-leave": {
                this.removePeer(msg.sessionId);
                this.updatePeers((peers) => {
                    peers.delete(msg.sessionId);
                });
                break;
            }
            case "voice-mute-status": {
                this.updatePeers((peers) => {
                    const peer = peers.get(msg.sessionId);
                    if (peer) {
                        peer.muted = msg.muted;
                    }
                });
                break;
            }
            case "voice-offer": {
                const pc = await this.createPeerConnection(msg.from, false);
                await pc.setRemoteDescription(
                    new RTCSessionDescription(msg.offer),
                );
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                this.send({
                    type: "voice-answer",
                    from: this.sessionId,
                    to: msg.from,
                    answer,
                });
                break;
            }
            case "voice-answer": {
                const pc = this.peerConnections.get(msg.from);
                if (pc) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(msg.answer),
                    );
                }
                break;
            }
            case "voice-ice": {
                const pc = this.peerConnections.get(msg.from);
                if (pc && msg.candidate) {
                    await pc.addIceCandidate(
                        new RTCIceCandidate(msg.candidate),
                    );
                }
                break;
            }
        }
    }

    private async createPeerConnection(
        peerId: string,
        createOffer: boolean,
    ): Promise<RTCPeerConnection> {
        if (this.peerConnections.has(peerId))
            return this.peerConnections.get(peerId)!;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.peerConnections.set(peerId, pc);

        if (this.localStream) {
            for (const track of this.localStream.getTracks()) {
                pc.addTrack(track, this.localStream);
            }
        }

        pc.ontrack = (event) => {
            let audio = this.audioElements.get(peerId);
            if (!audio) {
                audio = document.createElement("audio");
                audio.autoplay = true;
                document.body.appendChild(audio);
                this.audioElements.set(peerId, audio);
            }
            audio.srcObject = event.streams[0];
            this.setupRemoteVAD(peerId, event.streams[0]);
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.send({
                    type: "voice-ice",
                    from: this.sessionId,
                    to: peerId,
                    candidate: event.candidate.toJSON(),
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (
                pc.connectionState === "disconnected" ||
                pc.connectionState === "failed"
            ) {
                this.removePeer(peerId);
                this.updatePeers((peers) => {
                    peers.delete(peerId);
                });
            }
        };

        if (createOffer) {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.send({
                type: "voice-offer",
                from: this.sessionId,
                to: peerId,
                offer,
            });
        }

        return pc;
    }

    private removePeer(peerId: string) {
        const pc = this.peerConnections.get(peerId);
        if (pc) {
            pc.close();
            this.peerConnections.delete(peerId);
        }
        const audio = this.audioElements.get(peerId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            this.audioElements.delete(peerId);
        }
        this.remoteAnalysers.delete(peerId);
        this.peerSpeakingUntil.delete(peerId);
    }

    // ── Voice Activity Detection ──

    private ensureAudioContext(): AudioContext {
        if (!this.audioContext) {
            this.audioContext = new AudioContext();
        }
        return this.audioContext;
    }

    private setupLocalVAD() {
        if (!this.localStream) return;
        const ctx = this.ensureAudioContext();
        const source = ctx.createMediaStreamSource(this.localStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        this.localAnalyser = analyser;
        this.startVADLoop();
    }

    private setupRemoteVAD(peerId: string, stream: MediaStream) {
        const ctx = this.ensureAudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        this.remoteAnalysers.set(peerId, analyser);
    }

    private startVADLoop() {
        if (this.vadInterval) return;
        const buffer = new Uint8Array(128);

        this.vadInterval = setInterval(() => {
            const now = Date.now();
            let changed = false;

            // Check local
            if (this.localAnalyser) {
                this.localAnalyser.getByteFrequencyData(buffer);
                let sum = 0;
                for (let i = 0; i < buffer.length; i++) sum += buffer[i];
                const avg = sum / buffer.length;
                if (avg > SPEAKING_THRESHOLD) {
                    this.selfSpeakingUntil = now + SPEAKING_HOLDOVER_MS;
                }
                const speaking = now < this.selfSpeakingUntil;
                if (speaking !== this.state.selfSpeaking) {
                    this.setState({ selfSpeaking: speaking });
                    changed = true;
                }
            }

            // Check remotes
            for (const [peerId, analyser] of this.remoteAnalysers) {
                analyser.getByteFrequencyData(buffer);
                let sum = 0;
                for (let i = 0; i < buffer.length; i++) sum += buffer[i];
                const avg = sum / buffer.length;
                if (avg > SPEAKING_THRESHOLD) {
                    this.peerSpeakingUntil.set(
                        peerId,
                        now + SPEAKING_HOLDOVER_MS,
                    );
                }
                const speaking =
                    now < (this.peerSpeakingUntil.get(peerId) ?? 0);
                const peer = this.state.peers.get(peerId);
                if (peer && peer.speaking !== speaking) {
                    changed = true;
                    // Will batch update below
                }
            }

            if (changed) {
                this.updatePeers((peers) => {
                    const now2 = Date.now();
                    for (const [peerId] of this.remoteAnalysers) {
                        const peer = peers.get(peerId);
                        if (peer) {
                            peer.speaking =
                                now2 <
                                (this.peerSpeakingUntil.get(peerId) ?? 0);
                        }
                    }
                });
            }
        }, VAD_INTERVAL_MS);
    }

    private stopVAD() {
        if (this.vadInterval) {
            clearInterval(this.vadInterval);
            this.vadInterval = null;
        }
        this.localAnalyser = null;
        this.remoteAnalysers.clear();
        this.peerSpeakingUntil.clear();
        this.selfSpeakingUntil = 0;
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
    }

    // ── Speech Recognition (trigger word detection) ──

    private startSpeechRecognition() {
        const SR =
            (window as any).SpeechRecognition ||
            (window as any).webkitSpeechRecognition;
        if (!SR) {
            console.warn("SpeechRecognition API not available");
            return;
        }

        const rec: ISpeechRecognition = new SR();
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = "en-US";

        rec.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                console.log(
                    `[speech] result[${i}] isFinal=${result.isFinal} transcript="${result[0].transcript}" confidence=${result[0].confidence.toFixed(2)}`,
                );
                if (!result.isFinal) continue;

                const raw = result[0].transcript.trim();
                this.setState({ lastTranscript: raw });

                const lower = raw.toLowerCase();
                const idx = lower.indexOf(this.triggerWord);
                console.log(
                    `[speech] looking for trigger "${this.triggerWord}" in "${lower}" → idx=${idx}`,
                );
                if (idx === -1) continue;

                const command = raw
                    .slice(idx + this.triggerWord.length)
                    .trim()
                    .replace(/^[,!.\s]+/, "")
                    .replace(/^(can you|could you|please)\s+/i, "")
                    .trim();

                console.log(
                    `[speech] extracted command: "${command}" (empty=${!command})`,
                );

                if (command && this.onCommand) {
                    console.log(
                        `[voice-trigger] "${this.triggerWord}" → "${command}"`,
                    );
                    this.onCommand(command);
                }
            }
        };

        rec.onend = () => {
            console.log(
                `[speech] onend fired — joined=${this.state.joined} listening=${this.state.listening}`,
            );
            if (this.state.joined && this.state.listening) {
                try {
                    rec.start();
                    console.log("[speech] restarted after onend");
                } catch {
                    console.log("[speech] restart failed (already started)");
                }
            }
        };

        rec.onerror = (event) => {
            console.error(`[speech] onerror: ${event.error}`);
            if (
                event.error === "not-allowed" ||
                event.error === "service-not-allowed"
            ) {
                this.setState({ listening: false });
            } else if (event.error === "network") {
                this.speechRetries++;
                if (this.speechRetries <= VoiceChatManager.MAX_SPEECH_RETRIES) {
                    console.warn(
                        `[speech] network error (attempt ${this.speechRetries}/${VoiceChatManager.MAX_SPEECH_RETRIES}) — retrying in 3s`,
                    );
                    setTimeout(() => {
                        if (this.state.joined && this.recognition) {
                            try {
                                this.recognition.start();
                            } catch {
                                /* already started */
                            }
                        }
                    }, 3000);
                } else {
                    console.error(
                        `[speech] network error — gave up after ${VoiceChatManager.MAX_SPEECH_RETRIES} retries.`,
                        `\n  URL: ${window.location.href}`,
                        `\n  Protocol: ${window.location.protocol}`,
                        "\n  Chrome's SpeechRecognition requires:",
                        "\n    1. Page served over HTTPS (or localhost)",
                        "\n    2. Internet access to reach Google's speech servers",
                        "\n    3. No VPN/firewall blocking Google services",
                    );
                    this.setState({ listening: false });
                }
            }
        };

        rec.start();
        this.recognition = rec;
        this.speechRetries = 0;
        this.setState({ listening: true });
        console.log(
            `[speech] started — trigger="${this.triggerWord}" continuous=true lang=en-US`,
            `\n  URL: ${window.location.href}`,
            `\n  Protocol: ${window.location.protocol}`,
        );
    }

    private stopSpeechRecognition() {
        if (this.recognition) {
            const r = this.recognition;
            this.recognition = null;
            r.onend = null;
            r.abort();
            this.setState({ listening: false });
        }
    }

    private cleanup() {
        this.stopSpeechRecognition();
        this.stopVAD();

        for (const peerId of Array.from(this.peerConnections.keys())) {
            this.removePeer(peerId);
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach((t) => t.stop());
            this.localStream = null;
        }

        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }

        this.setState({
            joined: false,
            muted: false,
            peerCount: 0,
            listening: false,
            peers: new Map(),
            selfSpeaking: false,
        });
    }

    destroy() {
        this.leave();
        this.listeners.clear();
    }
}
