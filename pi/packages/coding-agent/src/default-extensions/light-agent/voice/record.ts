/**
 * Audio recording using ffmpeg or sox (`rec`) spawned as a child process.
 * Mirrors the approach used by opencode-audio's src/audio/record.ts, but
 * adapted to Node's child_process API.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function which(bin: string): boolean {
	const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of paths) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				if (existsSync(`${dir}/${bin}${ext}`)) return true;
			} catch {
				// ignore
			}
		}
	}
	return false;
}

/**
 * Query DirectShow for audio capture devices on Windows. ffmpeg prints
 * the device list to stderr and exits non-zero, which is expected.
 */
function enumerateWindowsAudioDevice(): string | undefined {
	try {
		const result = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 5_000,
			encoding: "utf8",
		});
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		const audioHeaderIndex = stderr.search(/DirectShow audio devices|audio devices/i);
		if (audioHeaderIndex < 0) return undefined;
		const audioSection = stderr.slice(audioHeaderIndex);
		const match = audioSection.match(/"([^"]+)"/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Detect whether a PulseAudio (or PipeWire pulse-compatibility) socket is
 * reachable for this process. Many minimal Linux desktops, servers, and
 * containers ship ALSA only, so we need to fall back instead of always
 * forcing `-f pulse`.
 */
function hasPulseSocket(): boolean {
	const candidates: string[] = [];
	const pulseServer = process.env.PULSE_SERVER?.trim();
	if (pulseServer) {
		// PULSE_SERVER can be a bare path or `unix:/path`.
		candidates.push(pulseServer.startsWith("unix:") ? pulseServer.slice("unix:".length) : pulseServer);
	}
	const xdg = process.env.XDG_RUNTIME_DIR?.trim();
	if (xdg) candidates.push(`${xdg}/pulse/native`);
	if (typeof process.getuid === "function") {
		candidates.push(`/run/user/${process.getuid()}/pulse/native`);
	}
	for (const c of candidates) {
		try {
			if (existsSync(c)) return true;
		} catch {
			// ignore permission errors and keep trying other candidates
		}
	}
	return false;
}

function cmd(): string[] {
	// Explicit device override wins on every platform.
	const deviceOverride = process.env.PI_AUDIO_DEVICE?.trim();

	if (which("rec")) return ["rec", "-q", "-t", "wav", "-"];
	if (which("ffmpeg")) {
		const base = ["-loglevel", "quiet", "-f"];
		const tail = ["-f", "wav", "-ac", "1", "-ar", "16000", "pipe:1"];

		if (process.platform === "darwin") {
			const dev = deviceOverride || ":default";
			return ["ffmpeg", ...base, "avfoundation", "-i", dev, ...tail];
		}

		if (process.platform === "win32") {
			const deviceName = deviceOverride || enumerateWindowsAudioDevice();
			if (!deviceName) {
				throw new Error(
					"No DirectShow audio capture device found. Plug in a microphone, or set " +
						'PI_AUDIO_DEVICE="<device name>" (see `ffmpeg -list_devices true -f dshow -i dummy`).',
				);
			}
			return ["ffmpeg", ...base, "dshow", "-i", `audio=${deviceName}`, ...tail];
		}

		// Linux / other POSIX: prefer PulseAudio/PipeWire when a server socket
		// is reachable, otherwise fall back to ALSA so voice works on minimal
		// desktops, servers, and containers that ship ALSA only. Users can
		// force a specific backend and device with PI_AUDIO_DEVICE, using the
		// format `pulse:<dev>` or `alsa:<dev>`; bare values default to the
		// auto-detected backend.
		const [forcedBackend, forcedDevice] = (() => {
			if (!deviceOverride) return [undefined, undefined] as const;
			const match = deviceOverride.match(/^(pulse|alsa):(.+)$/);
			if (match) return [match[1] as "pulse" | "alsa", match[2]!] as const;
			return [undefined, deviceOverride] as const;
		})();
		const backend = forcedBackend ?? (hasPulseSocket() ? "pulse" : "alsa");
		const dev = forcedDevice ?? "default";
		return ["ffmpeg", ...base, backend, "-i", dev, ...tail];
	}

	const installHint =
		process.platform === "darwin"
			? "Install with: brew install ffmpeg"
			: process.platform === "win32"
				? "Install with: winget install ffmpeg (or choco install ffmpeg)"
				: "Install via your package manager (apt/dnf/pacman install ffmpeg, or brew install sox).";
	throw new Error(`ffmpeg or sox is required for voice recording. ${installHint}`);
}

export interface Recording {
	/** Stop recording and return the captured audio as WAV bytes. */
	stop(): Promise<Uint8Array>;
}

export function record(): Recording {
	const [bin, ...args] = cmd();
	const proc: ChildProcess = spawn(bin, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Collect stdout chunks while recording so we don't race with SIGTERM.
	const chunks: Buffer[] = [];
	proc.stdout?.on("data", (data: Buffer) => {
		chunks.push(data);
	});

	// Swallow stderr to avoid noisy output.
	proc.stderr?.on("data", () => {});

	let startError: Error | undefined;
	proc.on("error", (err) => {
		startError = err;
	});

	let stopped = false;

	// Wait for `close` specifically — `exit` can fire before the stdout pipe
	// has drained, which would cause us to assemble the WAV buffer before
	// the last chunks arrive and truncate longer recordings on slower
	// machines. Per Node's docs, `close` always emits after `exit` (or
	// after `error` if the child failed to spawn), so waiting on it alone
	// is safe and guarantees we've received every byte from stdout.
	const exited = new Promise<void>((resolve) => {
		proc.once("close", () => resolve());
	});

	return {
		async stop(): Promise<Uint8Array> {
			if (startError) throw startError;
			if (!stopped) {
				stopped = true;
				try {
					proc.kill("SIGTERM");
				} catch {
					// ignore
				}
			}
			await exited;
			if (startError) throw startError;
			let total = 0;
			for (const c of chunks) total += c.length;
			const out = new Uint8Array(total);
			let offset = 0;
			for (const c of chunks) {
				out.set(c, offset);
				offset += c.length;
			}
			return out;
		},
	};
}
