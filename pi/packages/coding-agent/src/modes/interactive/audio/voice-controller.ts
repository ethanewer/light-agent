/**
 * Voice controller: manages recording state and drives transcription.
 *
 * Consumers call `toggle()` (space key) to start/stop a recording that is
 * transcribed and sent via `onResult`, or `finish()` (ctrl+space during
 * recording) to transcribe without auto-submitting, surfacing the text
 * through `onFinish`.
 */

import { type Recording, record } from "./record.js";
import { DEFAULT_TRANSCRIPTION_MODEL, transcribe } from "./transcribe.js";

export type VoiceState = "idle" | "recording" | "transcribing";

export interface VoiceControllerOptions {
	/** Resolve the OpenAI API key on demand. */
	getApiKey: () => Promise<string | undefined>;
	/**
	 * Resolve the base URL to use for transcription. If unset or returning
	 * undefined, the OpenAI default is used. Lets installations that route
	 * `openai` through a proxy or custom base URL keep voice transcription
	 * working in the same environments where normal chat requests succeed.
	 */
	getBaseUrl?: () => Promise<string | undefined> | string | undefined;
	/** Transcription model override (default: gpt-4o-mini-transcribe). */
	model?: string;
	/** Called with transcription text after a space-completed recording (send). */
	onResult: (text: string) => void;
	/** Called with transcription text after a ctrl+space-completed recording (edit). */
	onFinish: (text: string) => void;
	/**
	 * Always fires once a transcription attempt ends, regardless of outcome.
	 * Lets callers drop any per-session state (captured editors, installed
	 * submit hooks, pending-submit buffers) even when onResult/onFinish
	 * didn't fire (empty transcript on send, errors, cancellation).
	 */
	onTranscriptionEnd?: (outcome: "result" | "finish" | "empty" | "error" | "cancelled") => void;
	/** Called whenever state or elapsed time changes so the UI can repaint. */
	onStateChange?: () => void;
	/** Called for transient user-facing errors. */
	onError?: (message: string) => void;
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

export class VoiceController {
	private state: VoiceState = "idle";
	private recording: Recording | undefined;
	private recordingStartMs = 0;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private tick = 0;
	private abortController: AbortController | undefined;
	private disposed = false;

	constructor(private readonly opts: VoiceControllerOptions) {}

	getState(): VoiceState {
		return this.state;
	}

	isRecording(): boolean {
		return this.state === "recording";
	}

	isTranscribing(): boolean {
		return this.state === "transcribing";
	}

	/** Elapsed recording time in seconds. */
	getElapsedSeconds(): number {
		if (this.state !== "recording" || !this.recordingStartMs) return 0;
		return Math.floor((Date.now() - this.recordingStartMs) / 1000);
	}

	/** Animated spinner frame index (updates while recording). */
	getTick(): number {
		return this.tick;
	}

	/** Toggle recording. When recording, transcribe and send via onResult. */
	toggle(): void {
		if (this.state === "transcribing") return;
		if (this.state === "recording") {
			this.stopAndTranscribe({ intent: "send" });
			return;
		}
		this.startRecording();
	}

	/**
	 * Stop recording and transcribe, routing the result to onFinish (edit
	 * instead of send). No-op if not currently recording.
	 */
	finish(): void {
		if (this.state !== "recording") return;
		this.stopAndTranscribe({ intent: "edit" });
	}

	/** Abort any in-flight recording/transcription without emitting results. */
	cancel(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}
		if (this.recording) {
			// Fire-and-forget: we don't care about the buffer after cancel.
			void this.recording.stop().catch(() => {});
			this.recording = undefined;
		}
		this.stopTickTimer();
		this.setState("idle");
	}

	dispose(): void {
		this.disposed = true;
		this.cancel();
	}

	private startRecording(): void {
		try {
			this.recording = record();
		} catch (err) {
			this.emitError(err instanceof Error ? err.message : "Failed to start recording");
			return;
		}
		this.recordingStartMs = Date.now();
		this.tick = 0;
		this.startTickTimer();
		this.setState("recording");
	}

	private stopAndTranscribe(opts: { intent: "send" | "edit" }): void {
		const rec = this.recording;
		if (!rec) return;
		this.recording = undefined;
		this.stopTickTimer();
		this.setState("transcribing");

		const abort = new AbortController();
		this.abortController = abort;

		const timer = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);

		let outcome: "result" | "finish" | "empty" | "error" | "cancelled" = "empty";
		(async () => {
			const audio = await rec.stop();
			if (abort.signal.aborted) throw new Error("Transcription cancelled");
			if (audio.length === 0) {
				// Nothing was captured — silently ignore.
				return "";
			}
			const apiKey = await this.opts.getApiKey();
			if (!apiKey) {
				throw new Error("OpenAI API key not configured. Run `/login openai` or set OPENAI_API_KEY.");
			}
			const baseUrl = this.opts.getBaseUrl ? await this.opts.getBaseUrl() : undefined;
			return await transcribe({
				apiKey,
				audio,
				model: this.opts.model ?? DEFAULT_TRANSCRIPTION_MODEL,
				baseUrl: baseUrl || undefined,
				abortSignal: abort.signal,
			});
		})()
			.then((text) => {
				if (this.disposed || abort.signal.aborted) {
					outcome = "cancelled";
					return;
				}
				if (opts.intent === "edit") {
					outcome = "finish";
					this.opts.onFinish(text ?? "");
				} else if (text?.trim()) {
					outcome = "result";
					this.opts.onResult(text);
				} else {
					outcome = "empty";
				}
			})
			.catch((err) => {
				if (this.disposed || abort.signal.aborted) {
					outcome = "cancelled";
					return;
				}
				outcome = "error";
				this.emitError(err instanceof Error ? err.message : "Transcription failed");
				if (opts.intent === "edit") {
					// Still return focus to the editor with an empty string so the
					// caller can switch modes even if transcription failed.
					this.opts.onFinish("");
				}
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.abortController === abort) {
					this.abortController = undefined;
				}
				if (this.state === "transcribing") {
					this.setState("idle");
				}
				if (!this.disposed) this.opts.onTranscriptionEnd?.(outcome);
			});
	}

	private startTickTimer(): void {
		this.stopTickTimer();
		this.tickTimer = setInterval(() => {
			this.tick++;
			this.opts.onStateChange?.();
		}, 80);
		(this.tickTimer as unknown as { unref?: () => void }).unref?.();
	}

	private stopTickTimer(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	private setState(state: VoiceState): void {
		if (this.state === state) return;
		this.state = state;
		this.opts.onStateChange?.();
	}

	private emitError(message: string): void {
		this.opts.onError?.(message);
	}
}
