/** Editor-area dialogs must restore the shell's previous home, not force the composer back. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type UiNode, jsx } from "@oh-my-pi/pi-tui";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Slot } from "../src/ui/shell/views";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

describe("editor-area dialog home restore", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let manager: SessionManager;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		directory = TempDir.createSync("@omp-editor-area-home-");
		await Settings.init({ inMemory: true, cwd: directory.path() });
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");

		manager = SessionManager.create(directory.path(), directory.path());
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});

		term = createModeTerminal();
		await term.start();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		await auth?.close();
		directory?.removeSync();
		resetSettingsForTest();
	});

	/** A non-composer home mounted in the dock, so the restore can be distinguished from the composer. */
	async function makeHome(): Promise<{ home: UiNode; slot: Slot }> {
		const slot = mode.shell.dock.slot("editorGap");
		slot.set(() => jsx("col", { children: [jsx("text", { text: "home marker" })] }));
		const view = slot.view();
		expect(view).toBeDefined();
		const home = view as UiNode;
		mode.shell.focus(home);
		mode.shell.setHome(home);
		await term.settle();
		return { home, slot };
	}

	it("restores a saved non-composer home when the dialog closes", async () => {
		const { home } = await makeHome();

		const dialog = mode.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		expect(mode.shell.focused()).toBe(dialog.node);
		expect(mode.shell.home()).toBe(dialog.node);

		dialog.close();
		expect(mode.shell.home()).toBe(home);
		expect(mode.shell.focused()).toBe(home);
	});

	it("falls back to the composer when the saved home is disposed while the dialog is open", async () => {
		const { home, slot } = await makeHome();

		const dialog = mode.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		slot.clear();
		expect(home.disposed).toBe(true);

		dialog.close();
		expect(mode.shell.home()).toBe(mode.composer.field);
		expect(mode.shell.focused()).toBe(mode.composer.field);
	});
});
