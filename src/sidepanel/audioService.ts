/**
 * PageGuide Audio Engine:
 * 1. Web Audio Earcons (tactile sound cues for screen-reader & blind navigation)
 * 2. Speech Synthesis (TTS voice output for scan announcements, answers, orientation)
 * 3. Speech Recognition / Audio Recording via navigator.mediaDevices.getUserMedia
 *    - Prompts Chrome for microphone permissions
 *    - Records speech with MediaRecorder + Voice Activity Detection (VAD)
 *    - Transcribes via OpenAI Whisper (high accuracy) with webkitSpeechRecognition fallback
 * 4. Hands-Free Conversational Voice Loop:
 *    - Wake-word detection ("PageGuide" -> "Yes?")
 *    - Automatic continuous listening during conversational turns
 *    - Acoustic feedback protection (recognition paused while assistant speaks)
 *    - Graceful exit via "Thanks PageGuide" / timeout returning to wake-word waiting
 */

export type EarconType =
  | "scan_start"
  | "scan_complete"
  | "focus_moved"
  | "toggle_on"
  | "toggle_off"
  | "mic_start"
  | "mic_end"
  | "error"
  | "image_described"
  | "repair_applied"
  | "wake_word";

export interface ListenOptions {
  apiKey?: string;
  onResult: (transcript: string) => void;
  onError?: (error: string, isPermissionError?: boolean) => void;
  onEnd?: () => void;
}

export type HandsFreeState =
  | "off"
  | "waiting_for_wake_word"
  | "listening_command"
  | "processing"
  | "speaking";

export interface HandsFreeOptions {
  onCommand: (text: string) => void;
  onError?: (error: string, isPermissionError?: boolean) => void;
}

const WAKE_WORD_PATTERN = /\b(hey\s+|hi\s+|ok\s+)?page\s*guide\b/i;
const EXIT_PATTERN =
  /\b(thanks?(\s+you)?(\s+page\s*guide)?|that'?s\s+all|goodbye|bye|nevermind|stop|done)\b/i;

class AudioService {
  private ctx: AudioContext | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private isSpeakingState = false;
  private speechListeners = new Set<(speaking: boolean) => void>();

  // Active mic stream & recorder (for manual push-to-talk / Whisper)
  private activeStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private activeRecognition: any = null;
  private isListeningState = false;
  private listeningListeners = new Set<(listening: boolean) => void>();
  private vadInterval: number | null = null;

  // Hands-free state management
  private handsFreeActive = false;
  private handsFreeState: HandsFreeState = "off";
  private handsFreeOptions: HandsFreeOptions | null = null;
  private handsFreeListeners = new Set<(state: HandsFreeState) => void>();
  private recognitionGeneration = 0;
  private commandDebounceTimer: number | null = null;
  private inactivityTimer: number | null = null;
  private lastExecutedCommand = "";
  private lastExecutedTime = 0;

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Play an earcon (tactile synthesized acoustic chime).
   */
  public playEarcon(type: EarconType): void {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      switch (type) {
        case "scan_start": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.exponentialRampToValueAtTime(880, now + 0.18);
          gain.gain.setValueAtTime(0.08, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.2);
          break;
        }

        case "scan_complete": {
          [523.25, 659.25, 783.99].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.08;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.12, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.25);
          });
          break;
        }

        case "focus_moved": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(800, now);
          osc.frequency.exponentialRampToValueAtTime(1400, now + 0.07);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.09);
          break;
        }

        case "toggle_on": {
          [440, 659.25].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.07;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.1, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.12);
          });
          break;
        }

        case "toggle_off": {
          [659.25, 440].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.07;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.1, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.12);
          });
          break;
        }

        case "mic_start": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(1046.5, now + 0.12);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.14);
          break;
        }

        case "mic_end": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(1046.5, now);
          osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.12);
          gain.gain.setValueAtTime(0.1, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.14);
          break;
        }

        case "error": {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.25);
          break;
        }

        case "image_described": {
          [440, 554.37, 659.25, 880].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.055;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.12, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.22);
          });
          break;
        }

        case "repair_applied": {
          [587.33, 880].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.07;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.09, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.15);
          });
          break;
        }

        case "wake_word": {
          [587.33, 880].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + i * 0.08;
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, start);
            gain.gain.setValueAtTime(0.14, start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(start);
            osc.stop(start + 0.16);
          });
          break;
        }
      }
    } catch {
      // AudioContext unavailable or blocked
    }
  }

  /**
   * Speak text out loud through Web Speech Synthesis.
   */
  public speak(
    text: string,
    options?: {
      interrupt?: boolean;
      rate?: number;
      onEnd?: () => void;
    }
  ): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      options?.onEnd?.();
      return;
    }

    const interrupt = options?.interrupt ?? true;
    if (interrupt) {
      this.stopSpeaking();
    }

    const cleanSpeech = text
      .replace(/\[pg-\d+\]/g, "")
      .replace(/[#*`_~]/g, "")
      .replace(/✓/g, "Repaired: ")
      .replace(/⚠/g, "Warning: ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanSpeech) {
      options?.onEnd?.();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanSpeech);
    utterance.rate = options?.rate ?? 1.05;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(
      (v) =>
        v.lang.startsWith("en") &&
        (v.name.includes("Natural") ||
          v.name.includes("Google") ||
          v.name.includes("Samantha") ||
          v.name.includes("Daniel") ||
          v.name.includes("Alex") ||
          v.name.includes("Siri"))
    );
    if (naturalVoice) {
      utterance.voice = naturalVoice;
    }

    this.currentUtterance = utterance;
    this.setSpeaking(true);

    // Pause recognition during speech so mic does not hear itself
    if (this.activeRecognition) {
      try {
        this.activeRecognition.abort();
      } catch {}
      this.activeRecognition = null;
    }

    utterance.onend = () => {
      this.setSpeaking(false);
      this.currentUtterance = null;
      options?.onEnd?.();
      this.handleSpeechEnded();
    };

    utterance.onerror = (e) => {
      if (e.error !== "interrupted" && e.error !== "canceled") {
        console.warn("SpeechSynthesis error:", e);
      }
      this.setSpeaking(false);
      this.currentUtterance = null;
      options?.onEnd?.();
      this.handleSpeechEnded();
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn("Unable to invoke speechSynthesis:", err);
      this.setSpeaking(false);
      options?.onEnd?.();
      this.handleSpeechEnded();
    }
  }

  public stopSpeaking(): void {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    this.setSpeaking(false);
    this.currentUtterance = null;
  }

  public isSpeaking(): boolean {
    return this.isSpeakingState;
  }

  public onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.speechListeners.add(cb);
    cb(this.isSpeakingState);
    return () => this.speechListeners.delete(cb);
  }

  private setSpeaking(val: boolean): void {
    this.isSpeakingState = val;
    this.speechListeners.forEach((cb) => cb(val));
  }

  private handleSpeechEnded(): void {
    if (this.handsFreeActive) {
      if (this.handsFreeState === "speaking" || this.handsFreeState === "processing") {
        this.setHandsFreeState("listening_command");
        this.resetInactivityTimer();
        window.setTimeout(() => {
          if (this.handsFreeActive && !this.isSpeakingState) {
            this.startContinuousListener();
          }
        }, 200);
      }
    }
  }

  // --- Speech Input with getUserMedia + Whisper / WebSpeech ---

  public isVoiceInputSupported(): boolean {
    return (
      typeof window !== "undefined" &&
      !!(
        navigator.mediaDevices?.getUserMedia ||
        (window as any).webkitSpeechRecognition ||
        (window as any).SpeechRecognition
      )
    );
  }

  /**
   * Open the dedicated permission tab where Chrome can display its native permission prompt.
   */
  public openPermissionTab(): void {
    const url =
      typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("permission.html")
        : "/permission.html";
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank");
    }
  }

  /**
   * Request microphone permission explicitly via getUserMedia.
   */
  public async requestMicrophonePermission(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      this.openPermissionTab();
      return false;
    }
  }

  // =========================================================================
  // Hands-Free Conversational Voice Loop
  // =========================================================================

  public async startHandsFree(options: HandsFreeOptions): Promise<void> {
    this.handsFreeOptions = options;
    this.handsFreeActive = true;
    this.setHandsFreeState("waiting_for_wake_word");
    this.startContinuousListener();
  }

  public stopHandsFree(): void {
    this.handsFreeActive = false;
    this.setHandsFreeState("off");
    this.clearInactivityTimer();
    this.clearCommandDebounce();
    this.recognitionGeneration++;
    if (this.activeRecognition) {
      try {
        this.activeRecognition.abort();
      } catch {}
      this.activeRecognition = null;
    }
  }

  public isHandsFreeActive(): boolean {
    return this.handsFreeActive;
  }

  public getHandsFreeState(): HandsFreeState {
    return this.handsFreeState;
  }

  public onHandsFreeStateChange(cb: (state: HandsFreeState) => void): () => void {
    this.handsFreeListeners.add(cb);
    cb(this.handsFreeState);
    return () => this.handsFreeListeners.delete(cb);
  }

  public notifyHandsFreeProcessing(processing: boolean): void {
    if (!this.handsFreeActive) return;
    if (processing) {
      this.setHandsFreeState("processing");
      this.clearInactivityTimer();
      this.clearCommandDebounce();
      this.recognitionGeneration++;
      if (this.activeRecognition) {
        try {
          this.activeRecognition.abort();
        } catch {}
        this.activeRecognition = null;
      }
    }
  }

  private setHandsFreeState(state: HandsFreeState): void {
    this.handsFreeState = state;
    this.handsFreeListeners.forEach((cb) => cb(state));
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = window.setTimeout(() => {
      if (this.handsFreeActive && this.handsFreeState === "listening_command") {
        this.setHandsFreeState("waiting_for_wake_word");
      }
    }, 14000);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer !== null) {
      window.clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private clearCommandDebounce(): void {
    if (this.commandDebounceTimer !== null) {
      window.clearTimeout(this.commandDebounceTimer);
      this.commandDebounceTimer = null;
    }
  }

  private startContinuousListener(): void {
    if (!this.handsFreeActive || this.isSpeakingState) return;

    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      this.handsFreeOptions?.onError?.(
        "Continuous speech recognition is not supported in this browser."
      );
      return;
    }

    if (this.activeRecognition) {
      try {
        this.activeRecognition.abort();
      } catch {}
      this.activeRecognition = null;
    }

    const currentGen = ++this.recognitionGeneration;

    try {
      const rec = new SpeechRec();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";

      rec.onresult = (event: any) => {
        if (this.isSpeakingState || currentGen !== this.recognitionGeneration) return;

        let finalTranscript = "";
        let interimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const piece = event.results[i][0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalTranscript += piece;
          } else {
            interimTranscript += piece;
          }
        }

        const candidate = (finalTranscript || interimTranscript).trim();
        if (!candidate) return;

        this.handleHandsFreeInput(candidate, Boolean(finalTranscript));
      };

      rec.onerror = (event: any) => {
        if (currentGen !== this.recognitionGeneration) return;
        if (event.error === "no-speech" || event.error === "aborted") return;
        console.warn("Hands-free speech recognition error:", event.error);
        if (event.error === "not-allowed") {
          this.openPermissionTab();
          this.handsFreeOptions?.onError?.(
            "Microphone permission needed. A tab has opened for you: please click 'Allow'.",
            true
          );
          this.stopHandsFree();
        }
      };

      rec.onend = () => {
        if (this.activeRecognition === rec) {
          this.activeRecognition = null;
        }
        if (
          this.handsFreeActive &&
          !this.isSpeakingState &&
          currentGen === this.recognitionGeneration
        ) {
          window.setTimeout(() => {
            if (
              this.handsFreeActive &&
              !this.isSpeakingState &&
              currentGen === this.recognitionGeneration
            ) {
              this.startContinuousListener();
            }
          }, 150);
        }
      };

      this.activeRecognition = rec;
      rec.start();
    } catch (err) {
      console.warn("Failed to start continuous listener:", err);
    }
  }

  private handleHandsFreeInput(text: string, isFinal: boolean): void {
    if (this.handsFreeState === "waiting_for_wake_word") {
      const match = text.match(WAKE_WORD_PATTERN);
      if (match) {
        this.playEarcon("wake_word");

        // Check if user combined wake word and command (e.g. "PageGuide, what's on this page?")
        const trailing = text
          .replace(WAKE_WORD_PATTERN, "")
          .replace(/^[:,\s]+/, "")
          .trim();

        if (trailing.length > 2) {
          this.triggerHandsFreeCommand(trailing);
        } else {
          // User said "PageGuide" -> prompt "Yes?" and listen for command
          this.setHandsFreeState("speaking");
          this.clearCommandDebounce();
          this.speak("Yes?", {
            onEnd: () => {
              this.setHandsFreeState("listening_command");
              this.resetInactivityTimer();
              this.startContinuousListener();
            },
          });
        }
      }
    } else if (this.handsFreeState === "listening_command") {
      if (!isFinal && text.length < 3) return;

      this.resetInactivityTimer();

      // Check for exit / thanks phrases
      if (EXIT_PATTERN.test(text)) {
        this.clearCommandDebounce();
        this.setHandsFreeState("speaking");
        this.clearInactivityTimer();
        this.speak("You're welcome.", {
          onEnd: () => {
            this.setHandsFreeState("waiting_for_wake_word");
            this.startContinuousListener();
          },
        });
        return;
      }

      // Strip any repeated wake word
      const cleaned =
        text.replace(WAKE_WORD_PATTERN, "").replace(/^[:,\s]+/, "").trim() || text;

      if (!cleaned) return;

      if (isFinal) {
        this.clearCommandDebounce();
        this.triggerHandsFreeCommand(cleaned);
      } else if (cleaned.length > 3) {
        // Debounce interim hypothesis so we don't fire too early
        this.clearCommandDebounce();
        this.commandDebounceTimer = window.setTimeout(() => {
          if (this.handsFreeState === "listening_command") {
            this.triggerHandsFreeCommand(cleaned);
          }
        }, 1200);
      }
    }
  }

  private triggerHandsFreeCommand(rawCommand: string): void {
    const command = rawCommand.trim();
    if (!command) return;

    // Guard against immediate duplicate submissions
    const now = Date.now();
    if (
      command.toLowerCase() === this.lastExecutedCommand.toLowerCase() &&
      now - this.lastExecutedTime < 2500
    ) {
      return;
    }

    this.lastExecutedCommand = command;
    this.lastExecutedTime = now;
    this.clearCommandDebounce();
    this.clearInactivityTimer();
    this.setHandsFreeState("processing");

    // Abort recognition to release mic during agent processing
    this.recognitionGeneration++;
    if (this.activeRecognition) {
      try {
        this.activeRecognition.abort();
      } catch {}
      this.activeRecognition = null;
    }

    this.handsFreeOptions?.onCommand(command);
  }

  // =========================================================================
  // Manual Push-to-Talk (Alt+M / Mic Button)
  // =========================================================================

  public async startListening(options: ListenOptions): Promise<void> {
    if (!this.isVoiceInputSupported()) {
      options.onError?.("Microphone access is not supported in this browser.", false);
      return;
    }

    if (this.isListeningState) {
      this.stopListening();
      return;
    }

    this.stopSpeaking();

    // If hands-free is active, trigger listening_command directly
    if (this.handsFreeActive) {
      this.playEarcon("wake_word");
      this.setHandsFreeState("listening_command");
      this.resetInactivityTimer();
      this.startContinuousListener();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.activeStream = stream;
    } catch (err: any) {
      this.setListening(false);
      this.playEarcon("error");
      const isDenied =
        err?.name === "NotAllowedError" ||
        err?.name === "PermissionDeniedError" ||
        (err?.message && String(err.message).toLowerCase().includes("denied"));

      if (isDenied) {
        this.openPermissionTab();
        options.onError?.(
          "Microphone permission is required. A tab has opened for you: please click 'Allow' in Chrome.",
          true
        );
      } else {
        options.onError?.(err?.message || "Unable to access microphone.", false);
      }
      options.onEnd?.();
      return;
    }

    this.setListening(true);
    this.playEarcon("mic_start");

    if (options.apiKey && typeof MediaRecorder !== "undefined") {
      this.recordWithWhisper(stream, options);
      return;
    }

    this.listenWithWebSpeech(stream, options);
  }

  private recordWithWhisper(stream: MediaStream, options: ListenOptions): void {
    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      this.mediaRecorder = recorder;
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = async () => {
        this.cleanupStream();
        if (chunks.length === 0) {
          options.onEnd?.();
          return;
        }

        const audioBlob = new Blob(chunks, { type: mimeType });
        if (audioBlob.size < 1000) {
          options.onError?.("No speech was heard. Please try again.");
          options.onEnd?.();
          return;
        }

        try {
          const transcript = await this.transcribeWithWhisper(
            audioBlob,
            options.apiKey!
          );
          if (transcript.trim()) {
            this.playEarcon("mic_end");
            options.onResult(transcript.trim());
          } else {
            options.onError?.("No words recognized. Please try again.");
          }
        } catch (err) {
          this.playEarcon("error");
          options.onError?.(
            err instanceof Error ? err.message : "Whisper transcription failed."
          );
        } finally {
          this.setListening(false);
          options.onEnd?.();
        }
      };

      recorder.start(100);

      this.setupVoiceActivityDetection(stream, () => {
        this.stopListening();
      });
    } catch (err) {
      this.cleanupStream();
      this.setListening(false);
      options.onError?.(
        err instanceof Error ? err.message : "Failed to record audio."
      );
      options.onEnd?.();
    }
  }

  private setupVoiceActivityDetection(
    stream: MediaStream,
    onSilence: () => void
  ): void {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let speechStarted = false;
      let silenceStart: number | null = null;
      const startTime = Date.now();

      this.vadInterval = window.setInterval(() => {
        if (!this.isListeningState) {
          this.clearVad();
          return;
        }

        if (Date.now() - startTime > 9000) {
          this.clearVad();
          onSilence();
          return;
        }

        analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const average = sum / buffer.length;

        if (average > 14) {
          speechStarted = true;
          silenceStart = null;
        } else if (speechStarted) {
          if (silenceStart === null) {
            silenceStart = Date.now();
          } else if (Date.now() - silenceStart > 1300) {
            this.clearVad();
            onSilence();
          }
        }
      }, 100);
    } catch {}
  }

  private clearVad(): void {
    if (this.vadInterval !== null) {
      window.clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
  }

  private async transcribeWithWhisper(
    audioBlob: Blob,
    apiKey: string
  ): Promise<string> {
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    formData.append("model", "whisper-1");
    formData.append("language", "en");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Whisper error (${res.status}): ${errText.slice(0, 100)}`);
    }

    const json = (await res.json()) as { text?: string };
    return json.text || "";
  }

  private listenWithWebSpeech(
    _stream: MediaStream,
    options: ListenOptions
  ): void {
    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRec) {
      this.cleanupStream();
      this.setListening(false);
      options.onError?.("Speech recognition is not available without an OpenAI API key.");
      options.onEnd?.();
      return;
    }

    try {
      const rec = new SpeechRec();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = "en-US";

      rec.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript || "";
        if (transcript) {
          this.playEarcon("mic_end");
          options.onResult(transcript);
        }
      };

      rec.onerror = (event: any) => {
        this.setListening(false);
        this.playEarcon("error");
        let msg = "Microphone error";
        if (event.error === "not-allowed") {
          msg = "Microphone permission denied. Enable microphone access in Chrome.";
        } else if (event.error === "no-speech") {
          msg = "No speech detected. Please try again.";
        }
        options.onError?.(msg);
      };

      rec.onend = () => {
        this.cleanupStream();
        this.setListening(false);
        this.activeRecognition = null;
        options.onEnd?.();
      };

      this.activeRecognition = rec;
      rec.start();
    } catch (err) {
      this.cleanupStream();
      this.setListening(false);
      this.playEarcon("error");
      options.onError?.(
        err instanceof Error ? err.message : "Failed to start microphone."
      );
      options.onEnd?.();
    }
  }

  public stopListening(): void {
    this.clearVad();

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try {
        this.mediaRecorder.stop();
      } catch {}
      this.mediaRecorder = null;
    } else {
      this.cleanupStream();
      this.setListening(false);
    }

    if (this.activeRecognition) {
      try {
        this.activeRecognition.stop();
      } catch {}
      this.activeRecognition = null;
    }
  }

  private cleanupStream(): void {
    if (this.activeStream) {
      this.activeStream.getTracks().forEach((track) => track.stop());
      this.activeStream = null;
    }
  }

  public isListening(): boolean {
    return this.isListeningState || this.handsFreeState === "listening_command";
  }

  public onListeningChange(cb: (listening: boolean) => void): () => void {
    this.listeningListeners.add(cb);
    cb(this.isListening());
    return () => this.listeningListeners.delete(cb);
  }

  private setListening(val: boolean): void {
    this.isListeningState = val;
    this.listeningListeners.forEach((cb) => cb(val));
  }
}

export const audio = new AudioService();
