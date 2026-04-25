import type { EditorComponent } from "@mariozechner/pi-tui";
import { matchesKey } from "@mariozechner/pi-tui";
import type { ExtensionAPI, ExtensionContext, ExtensionEditorInputEvent } from "../../core/extensions/types.js";
import { VoiceController } from "./voice/voice-controller.js";

const VOICE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function buildVoiceStatusLine(ctx: ExtensionContext, controller: VoiceController, voiceModeEnabled: boolean): string {
	const theme = ctx.ui.theme;
	if (controller.isTranscribing()) {
		const dot = theme.bold(theme.fg("accent", "◉"));
		return `${dot} ${theme.fg("dim", "Transcribing…")}`;
	}
	const key = (label: string) => theme.fg("muted", label);
	const desc = (label: string) => theme.fg("dim", label);
	const sep = theme.fg("dim", "·");
	if (controller.isRecording()) {
		const dot = theme.bold(theme.fg("error", "◉"));
		const frame = VOICE_SPINNER_FRAMES[controller.getTick() % VOICE_SPINNER_FRAMES.length];
		const elapsed = controller.getElapsedSeconds();
		const min = String(Math.floor(elapsed / 60)).padStart(2, "0");
		const sec = String(elapsed % 60).padStart(2, "0");
		const active = theme.fg("error", `${frame} Rec ${min}:${sec}`);
		const hint = `${key("space")} ${desc("send")} ${sep} ${key("shift+space")} ${desc("or")} ${key("type")} ${desc("to enter text input")}`;
		return `${dot} ${active}  ${hint}`;
	}
	if (voiceModeEnabled) {
		const dot = theme.bold(theme.fg("accent", "◉"));
		const hint = `${key("space")} ${desc("record")} ${sep} ${key("shift+space")} ${desc("or")} ${key("type")} ${desc("to enter text input")}`;
		return `${dot} ${hint}`;
	}
	return "";
}

export function registerVoice(pi: ExtensionAPI): void {
	let controller: VoiceController | undefined;
	let voiceModeEnabled = true;
	let targetEditor: EditorComponent | undefined;
	let originalOnSubmit: EditorComponent["onSubmit"] | undefined;
	let pendingSubmit: string | undefined;
	let currentCtx: ExtensionContext | undefined;

	function getOpenAIBaseUrl(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.modelRegistry.getAvailable().find((model) => model.provider === "openai")?.baseUrl || undefined;
		} catch {
			return undefined;
		}
	}

	function enterVoiceMode(ctx?: ExtensionContext): void {
		voiceModeEnabled = true;
		ctx?.ui.setEditorPlaceholder("light-agent-voice", () =>
			controller ? buildVoiceStatusLine(ctx, controller, voiceModeEnabled) : undefined,
		);
	}

	function exitVoiceMode(ctx?: ExtensionContext): void {
		voiceModeEnabled = false;
		ctx?.ui.setEditorPlaceholder("light-agent-voice", () =>
			controller && (controller.isRecording() || controller.isTranscribing())
				? buildVoiceStatusLine(ctx, controller, voiceModeEnabled)
				: undefined,
		);
	}

	function beginVoiceSession(event: ExtensionEditorInputEvent): void {
		targetEditor = event.editor;
		pendingSubmit = undefined;
		originalOnSubmit = targetEditor.onSubmit;
		targetEditor.onSubmit = (text: string) => {
			pendingSubmit = text;
		};
	}

	function finalizeVoiceSession(): void {
		const target = targetEditor;
		if (target && originalOnSubmit !== undefined) target.onSubmit = originalOnSubmit;
		const pending = pendingSubmit;
		const submit = originalOnSubmit;
		originalOnSubmit = undefined;
		targetEditor = undefined;
		pendingSubmit = undefined;
		if (pending?.trim()) submit?.(pending);
	}

	function handleVoiceResult(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const submit = originalOnSubmit;
		const pending = pendingSubmit;
		pendingSubmit = undefined;
		const combined = pending?.trim() ? `${trimmed} ${pending}` : trimmed;
		submit?.(combined);
	}

	function handleVoiceFinish(text: string): void {
		const ctx = currentCtx;
		const target = targetEditor;
		exitVoiceMode(ctx);
		const trimmed = text.trim();
		const pending = pendingSubmit;
		if (pending !== undefined) {
			pendingSubmit = undefined;
			const sep = pending.startsWith(" ") || pending.startsWith("\n") || !pending ? "" : " ";
			const combined = trimmed ? `${trimmed}${sep}${pending}` : pending;
			if (combined.trim()) originalOnSubmit?.(combined);
			return;
		}
		if (!trimmed || !target) return;
		const current = target.getText();
		if (!current) {
			target.setText(trimmed);
			return;
		}
		const sep = current.startsWith(" ") || current.startsWith("\n") ? "" : " ";
		const prefix = `${trimmed}${sep}`;
		if (target.prependText) target.prependText(prefix);
		else target.setText(prefix + current);
	}

	function handleVoiceKey(event: ExtensionEditorInputEvent): boolean | undefined {
		const ctx = currentCtx;
		const vc = controller;
		if (!ctx || !vc) return undefined;
		const isSpace = matchesKey(event.data, "space");
		const isCtrlSpace = matchesKey(event.data, "ctrl+space");
		const isShiftSpace = matchesKey(event.data, "shift+space");
		const isModSpace = isCtrlSpace || isShiftSpace;

		if (!voiceModeEnabled) {
			if (isModSpace && !vc.isRecording() && !vc.isTranscribing() && !event.editor.getText()) {
				enterVoiceMode(ctx);
				event.requestRender();
				return true;
			}
			return undefined;
		}

		if (vc.isTranscribing()) return isSpace || isModSpace ? true : undefined;

		if (isModSpace) {
			if (vc.isRecording()) {
				beginVoiceSession(event);
				vc.finish();
				exitVoiceMode(ctx);
			} else {
				exitVoiceMode(ctx);
			}
			event.requestRender();
			return true;
		}

		if (isSpace) {
			if (vc.isRecording()) beginVoiceSession(event);
			vc.toggle();
			event.requestRender();
			return true;
		}

		if (vc.isRecording()) {
			beginVoiceSession(event);
			vc.finish();
		}
		exitVoiceMode(ctx);
		event.requestRender();
		return undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		voiceModeEnabled = true;
		controller?.dispose();
		controller = new VoiceController({
			getApiKey: () => ctx.modelRegistry.getApiKeyForProvider("openai"),
			getBaseUrl: () => getOpenAIBaseUrl(ctx),
			onResult: handleVoiceResult,
			onFinish: handleVoiceFinish,
			onTranscriptionEnd: finalizeVoiceSession,
			onStateChange: () =>
				ctx.ui.setEditorPlaceholder("light-agent-voice", () =>
					controller ? buildVoiceStatusLine(ctx, controller, voiceModeEnabled) : undefined,
				),
			onError: (message) => ctx.ui.notify(message, "error"),
		});
		ctx.ui.setEditorPlaceholder("light-agent-voice", () =>
			controller ? buildVoiceStatusLine(ctx, controller, voiceModeEnabled) : undefined,
		);
		ctx.ui.addEditorInputHandler(handleVoiceKey);
	});

	pi.on("session_shutdown", () => {
		controller?.dispose();
		controller = undefined;
		currentCtx = undefined;
	});

	pi.registerCommand("voice", {
		description: "Re-enter voice input mode",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			enterVoiceMode(ctx);
		},
	});
}
