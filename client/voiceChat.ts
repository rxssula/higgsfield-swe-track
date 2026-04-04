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
    | { type: "voice-join"; sessionId: string }
    | { type: "voice-leave"; sessionId: string }
    | { type: "voice-peers"; peers: string[] }
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

export type VoiceState = {
    joined: boolean;
    muted: boolean;
    peerCount: number;
    listening: boolean;
    lastTranscript: string;
};

type VoiceStateListener = (state: VoiceState) => void;

export class VoiceChatManager {
    private ws: WebSocket | null = null;
    private sessionId: string;
    private roomId: string;
    private localStream: MediaStream | null = null;
    private peers = new Map<string, RTCPeerConnection>();
    private audioElements = new Map<string, HTMLAudioElement>();
    private recognition: ISpeechRecognition | null = null;
    private state: VoiceState = {
        joined: false,
        muted: false,
        peerCount: 0,
        listening: false,
        lastTranscript: "",
    };
    private listeners = new Set<VoiceStateListener>();
    private triggerWord: string;
    private onCommand: ((command: string) => void) | null = null;
    private speechRetries = 0;
    private static MAX_SPEECH_RETRIES = 3;

    constructor(
        roomId: string,
        opts?: { triggerWord?: string; onCommand?: (command: string) => void },
    ) {
        this.roomId = roomId;
        this.sessionId = "v-" + crypto.randomUUID().slice(0, 8);
        this.triggerWord = (opts?.triggerWord ?? "jose").toLowerCase();
        this.onCommand = opts?.onCommand ?? null;
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

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/voice/${this.roomId}?sessionId=${this.sessionId}`;
        this.ws = new WebSocket(url);

        this.ws.onmessage = (ev) => {
            const msg: SignalMessage = JSON.parse(ev.data);
            this.handleSignal(msg);
        };

        this.ws.onopen = () => {
            this.send({ type: "voice-join", sessionId: this.sessionId });
            this.setState({ joined: true });
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
        this.setState({ muted: !track.enabled });
    }

    private send(msg: SignalMessage) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private async handleSignal(msg: SignalMessage) {
        switch (msg.type) {
            case "voice-peers": {
                for (const peerId of msg.peers) {
                    await this.createPeerConnection(peerId, true);
                }
                this.setState({ peerCount: this.peers.size });
                break;
            }
            case "voice-join": {
                if (msg.sessionId !== this.sessionId) {
                    this.setState({ peerCount: this.peers.size + 1 });
                }
                break;
            }
            case "voice-leave": {
                this.removePeer(msg.sessionId);
                this.setState({ peerCount: this.peers.size });
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
                const pc = this.peers.get(msg.from);
                if (pc) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription(msg.answer),
                    );
                }
                break;
            }
            case "voice-ice": {
                const pc = this.peers.get(msg.from);
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
        if (this.peers.has(peerId)) return this.peers.get(peerId)!;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.peers.set(peerId, pc);

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
                this.setState({ peerCount: this.peers.size });
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
        const pc = this.peers.get(peerId);
        if (pc) {
            pc.close();
            this.peers.delete(peerId);
        }
        const audio = this.audioElements.get(peerId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            this.audioElements.delete(peerId);
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
                            } catch { /* already started */ }
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

        for (const peerId of Array.from(this.peers.keys())) {
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
        });
    }

    destroy() {
        this.leave();
        this.listeners.clear();
    }
}
