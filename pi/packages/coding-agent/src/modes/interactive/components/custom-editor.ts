import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;
	/**
	 * Voice input mode hook. Invoked with every raw input chunk *before* any
	 * other handling. Returning `true` means the key was consumed and no
	 * further editor processing should happen.
	 */
	public onVoiceInput?: (
		data: string,
		keyInfo: { isSpace: boolean; isCtrlSpace: boolean; isShiftSpace: boolean },
	) => boolean;
	/**
	 * Provider for placeholder text rendered inside the editor's content area
	 * when the editor is empty. Used for the voice-recording indicator.
	 * Returning `undefined` falls back to the normal empty-editor rendering
	 * (blinking cursor).
	 */
	public placeholderLine?: () => string | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Placeholder overlay: replace the first content line of the editor
		// (where the cursor sits on an empty buffer) with custom placeholder
		// text. We deliberately omit the CURSOR_MARKER so the hardware cursor
		// is hidden while the placeholder is shown (TUI hides the cursor when
		// no marker is present in the rendered output).
		const placeholder = this.placeholderLine?.();
		if (placeholder !== undefined && this.getText().length === 0 && lines.length >= 2) {
			lines[1] = this.renderPlaceholderLine(placeholder, width);
		}

		return lines;
	}

	private renderPlaceholderLine(text: string, width: number): string {
		const paddingX = this.getPaddingX();
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const effectivePad = Math.min(paddingX, maxPadding);
		const left = " ".repeat(effectivePad);
		const right = " ".repeat(effectivePad);
		const contentWidth = Math.max(1, width - effectivePad * 2);

		const textWidth = visibleWidth(text);
		const truncated = textWidth > contentWidth ? truncateToWidth(text, contentWidth) : text;
		const actualWidth = visibleWidth(truncated);
		const fill = " ".repeat(Math.max(0, contentWidth - actualWidth));
		return `${left}${truncated}${fill}${right}`;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Voice-mode hook runs before any other input handling so it can
		// intercept space / ctrl+space / shift+space (and exit voice mode on
		// other keys) without conflicting with registered app actions.
		if (this.onVoiceInput) {
			const isSpace = matchesKey(data, "space");
			const isCtrlSpace = matchesKey(data, "ctrl+space");
			const isShiftSpace = matchesKey(data, "shift+space");
			if (this.onVoiceInput(data, { isSpace, isCtrlSpace, isShiftSpace })) {
				return;
			}
		}

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
