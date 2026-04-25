/**
 * Audio transcription via OpenAI's `/v1/audio/transcriptions` endpoint.
 *
 * Uses the same default model as opencode-audio (`gpt-4o-mini-transcribe`).
 */

export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

export interface TranscribeOptions {
	apiKey: string;
	audio: Uint8Array;
	model?: string;
	baseUrl?: string;
	abortSignal?: AbortSignal;
	filename?: string;
	mimeType?: string;
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
	const {
		apiKey,
		audio,
		model = DEFAULT_TRANSCRIPTION_MODEL,
		baseUrl = "https://api.openai.com/v1",
		abortSignal,
		filename = "recording.wav",
		mimeType = "audio/wav",
	} = opts;

	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required for voice transcription");
	}

	const form = new FormData();
	// Copy into a fresh ArrayBuffer slice so we have a non-SharedArrayBuffer backing.
	const view = audio.slice();
	const blob = new Blob([view], { type: mimeType });
	form.append("file", blob, filename);
	form.append("model", model);
	// Plain text response — trims quoting and JSON overhead.
	form.append("response_format", "text");

	const url = `${baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: form,
		signal: abortSignal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Transcription request failed (${res.status}): ${body || res.statusText}`);
	}

	const text = await res.text();
	return text.trim();
}
