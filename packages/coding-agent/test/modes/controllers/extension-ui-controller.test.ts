import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import { type AgentMessage, Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { jsx } from "@oh-my-pi/pi-tui";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import type { ExtensionAskDialogQuestion, ExtensionUIContext } from "../../../src/extensibility/extensions";
import type { ExtensionRows } from "../../../src/extensibility/extensions/render-types";
import { isSettingsInitialized, Settings } from "../../../src/config/settings";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import type { ApprovalSubmitOptions, ApprovalSubmitOutcome, InteractiveModeContext } from "../../../src/modes/types";
import { APPROVE_ARM_MS } from "../../../src/modes/view-model/overlays/approval-dialog";
import type { PromptOptions, SteerOptions } from "../../../src/session/agent-session-types";
import { initTheme } from "../../../src/ui/theme/service";
import * as externalEditor from "../../../src/utils/external-editor";
import {
	disposeProgramStatus,
	initProgramStatus,
	setProgramStatusEnabled,
	setRunStatus,
} from "../../../src/utils/run-status";
import * as titleGenerator from "../../../src/utils/title-generator";
import { attachTerminal, createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

function makeHarness() {
	let uiContext: ExtensionUIContext | undefined;
	// A real agent-core queue: approvals track and reorder its steering messages.
	const agent = new Agent();
	const steeringChips = () =>
		agent.peekSteeringQueue().map(message => (message.role === "user" ? String(message.content) : ""));
	const steerCalls: { text: string; images: ImageContent[] | undefined; options?: SteerOptions }[] = [];
	const sentMessages: { message: unknown; options: unknown }[] = [];
	/** Steer the way `AgentSession.steer` does: report the queued messages, then push them onto the queue. */
	const steerMock = vi.fn(async (text: string, images?: ImageContent[], options?: SteerOptions) => {
		steerCalls.push({ text, images, options });
		const message = { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
		options?.onPromptQueued?.([message]);
		agent.steer(message);
	});
	/** Skill dispatch pushes its custom message onto the steering queue, as the session would. */
	const promptCustomMessage = vi.fn(async (message: unknown, options?: PromptOptions) => {
		sentMessages.push({ message, options });
		const queued = {
			role: "custom",
			customType: "skill-prompt",
			content: "",
			timestamp: Date.now(),
		} as AgentMessage;
		options?.onPromptQueued?.([queued]);
		agent.steer(queued);
		return true;
	});
	const ctx: InteractiveModeContext = createInteractiveModeContext({
		session: {
			agent,
			setUsageFallbackConfirmer: vi.fn(),
			// Slash-command dispatch consults these for every submission.
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: steeringChips(), followUp: [], liveSteered: 0 }),
			subscribe: ((listener: (event: { type: string; steering?: string[] }) => void) =>
				agent.onQueueChange(() =>
					listener({ type: "queue_update", steering: steeringChips() }),
				)) as unknown as InteractiveModeContext["session"]["subscribe"],
			steer: steerMock as unknown as InteractiveModeContext["session"]["steer"],
			promptCustomMessage:
				promptCustomMessage as unknown as InteractiveModeContext["session"]["promptCustomMessage"],
		},
		setToolUIContext: (context: ExtensionUIContext, hasUI: boolean) => {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		addAutocompleteProvider: vi.fn(),
	});
	const term: TestTerminal = attachTerminal(ctx);
	const controller = new ExtensionUiController(ctx);
	const composer = ctx.composer;
	/** The chord goes through the real submit path; a harness overrides it when it wants a stubbed outcome. */
	const submitApprovalNote = (text: string, options?: ApprovalSubmitOptions) =>
		new InputController(ctx, { readImage: async () => null, readText: async () => "" }).submitApprovalNote(
			text,
			options,
		);
	ctx.submitApprovalNote = submitApprovalNote;
	return {
		ctx,
		term,
		composer,
		controller,
		agent,
		submitApprovalNote,
		askSlot: () => ctx.shell.dock.slot("ask").occupied(),
		approvalSlot: () => ctx.shell.dock.slot("approval").occupied(),
		/** The screen as it paints now, plain. */
		screen(): string {
			term.render();
			return term.screen().join("\n");
		},
		composerFocused: () => ctx.shell.focused() === composer.field,
		/** Queue a user steer the way the session does: the agent queue grows and notifies. */
		queueSteer(text: string): void {
			agent.steer({ role: "user", content: text, timestamp: Date.now() });
		},
		/** Deliver the queued steering at the batch boundary: the queue empties. */
		deliverSteering(): void {
			agent.clearSteeringQueue();
		},
		/** Steer with what the composer submits, as the input controller does while a call waits. */
		steerOnSubmit(): void {
			composer.onSubmit = text => agent.steer({ role: "user", content: text, timestamp: Date.now() });
		},
		async init(): Promise<ExtensionUIContext> {
			await controller.initHooksAndCustomTools();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
		get steering(): string[] {
			return steeringChips();
		},
		get steer() {
			return steerMock;
		},
		get steerCalls() {
			return steerCalls;
		},
		get sentMessages(): { message: unknown; options: unknown }[] {
			return sentMessages;
		},
	};
}

/** Settle the microtasks `showHookCustom`'s factory chain and nested prompts run on. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Drain a deep chord submit chain: hooks, dispatch, queue notifications and the dialog settle. */
async function settleChord(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("ExtensionUiController form dialog", () => {
	const html = `<form>
		<fieldset><legend>Database</legend>
			<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
			<label><input type="radio" name="db" value="postgres"> Postgres</label>
		</fieldset>
	</form>`;

	it("shows the form above the composer with the keys and resolves the submitted data", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showFormDialog(html);
		expect(harness.askSlot()).toBe(true);
		expect(harness.composerFocused()).toBe(false);
		expect(harness.screen()).toContain("Postgres");

		harness.term.press("down");
		harness.term.press("space");
		harness.term.press("tab");
		harness.term.press("enter");

		expect(await pending).toEqual({ data: { db: "postgres" } });
		expect(harness.askSlot()).toBe(false);
		expect(harness.composerFocused()).toBe(true);
	});

	it("gives the form's text boxes the app's Vim mode: Esc leaves Insert before handing the keys back", async () => {
		const harness = makeHarness();
		Object.assign(harness.ctx, { dialogVim: () => ({}) });
		const pending = harness.controller.showFormDialog(`<form><label>Name <input name="name"></label></form>`);
		harness.term.type("hello world");
		harness.term.press("escape");
		expect(harness.controller.askHoldsKeys()).toBe(true);
		harness.term.type("bD");
		harness.term.press("enter");

		expect(await pending).toEqual({ data: { name: "hello " } });
	});

	it("hands the keys to the composer on Esc; Cancel resolves undefined", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showFormDialog(html);
		harness.term.press("escape");
		expect(harness.composerFocused()).toBe(true);
		expect(harness.askSlot()).toBe(true);
		expect(harness.controller.askHoldsKeys()).toBe(false);

		expect(harness.controller.focusAsk()).toBe(true);
		expect(harness.controller.askHoldsKeys()).toBe(true);
		// The Cancel button.
		bubbleEvent([harness.ctx.shell.focused()!], { type: "action", key: "actions/cancel", act: "cancel", mods: [] });
		expect(await pending).toBeUndefined();
		expect(harness.askSlot()).toBe(false);
		expect(harness.composerFocused()).toBe(true);
	});

	it("submits current values and an active note draft when the timeout lapses", async () => {
		const harness = makeHarness();
		const onTimeout = vi.fn();
		const pending = harness.controller.showFormDialog(html, { timeout: 20, onTimeout });
		harness.term.press("n");
		harness.term.type("local store");

		const result = await pending;
		expect(result?.timedOut).toBe(true);
		expect(result?.data).toEqual({ db: "sqlite" });
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(harness.askSlot()).toBe(false);
	});

	it("tears the form down when the signal aborts and reports what was answered", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		const onAbandon = vi.fn();
		const pending = harness.controller.showFormDialog(html, { signal: abort.signal, onAbandon });
		harness.term.press("down");
		harness.term.press("space");
		abort.abort();

		expect(await pending).toBeUndefined();
		expect(onAbandon).toHaveBeenCalledWith({ data: { db: "postgres" } });
		expect(harness.askSlot()).toBe(false);
		expect(harness.composerFocused()).toBe(true);
	});

	it("leaves the keys with a draft the user is typing when the form lands; a draft would skip it", async () => {
		const harness = makeHarness();
		harness.composer.setText("half typed");
		const pending = harness.controller.showFormDialog(html, { signal: AbortSignal.timeout(2_000) });
		expect(harness.composerFocused()).toBe(true);
		expect(harness.controller.composerAsk()).toBe("skip");
		expect(harness.controller.askHoldsKeys()).toBe(false);
		harness.composer.setText("/model");
		expect(harness.controller.composerAsk()).toBe("pending");
		expect(harness.controller.focusAsk()).toBe(true);
		expect(harness.controller.askHoldsKeys()).toBe(true);
		harness.term.press("tab");
		harness.term.press("enter");
		expect(await pending).toEqual({ data: { db: "sqlite" } });
		expect(harness.composer.text()).toBe("/model");
		expect(harness.controller.composerAsk()).toBeUndefined();
	});
});

describe("ExtensionUiController ask dialog", () => {
	const questions: ExtensionAskDialogQuestion[] = [
		{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] },
	];

	it("shows an ask above a populated prompt, which keeps the keys until they move to the ask", async () => {
		const harness = makeHarness();
		harness.composer.setText("finish this word");
		const pending = harness.controller.showAskDialog(questions);
		expect(harness.askSlot()).toBe(true);
		expect(harness.composerFocused()).toBe(true);

		harness.controller.focusAsk();
		harness.term.press("enter");
		const result = await pending;
		expect(result?.kind).toBe("submit");
		expect(result?.kind === "submit" && result.results[0]?.selectedOptions).toEqual(["Yes"]);
		expect(harness.askSlot()).toBe(false);
		expect(harness.composer.text()).toBe("finish this word");
		expect(harness.composerFocused()).toBe(true);
	});

	it("gives the composer its place back and the ask the keys when a nested prompt closes", async () => {
		const harness = makeHarness();
		void harness.controller.showAskDialog(questions);
		const ask = harness.ctx.shell.focused();
		expect(ask).not.toBe(harness.composer.field);

		// The note prompt takes the composer's place, the ask staying above it.
		harness.term.press("n");
		await flushMicrotasks();
		expect(harness.ctx.showEditorAreaDialog).toHaveBeenCalledTimes(1);
		const prompt = (harness.ctx.showEditorAreaDialog as Mock<InteractiveModeContext["showEditorAreaDialog"]>).mock
			.results[0]!.value as { closed: boolean };
		expect(harness.ctx.shell.focused()).not.toBe(ask);
		expect(harness.askSlot()).toBe(true);

		harness.term.press("escape");
		await flushMicrotasks();
		expect(prompt.closed).toBe(true);
		expect(harness.ctx.shell.focused()).toBe(ask);
	});
});

describe("ExtensionUiController image paste into prompts", () => {
	const PNG = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);

	beforeAll(async () => {
		if (!isSettingsInitialized()) await Settings.init({ inMemory: true });
	});

	/** A harness whose image pastes run through a real input controller reading `PNG` from the clipboard. */
	function imageHarness() {
		const harness = makeHarness();
		const input = new InputController(harness.ctx, {
			readImage: async () => ({ data: new Uint8Array(PNG), mimeType: "image/png" }),
			readText: async () => "",
			readMacFileUrls: async () => [],
			isTerminalLocal: () => true,
		});
		Object.assign(harness.ctx, {
			handleImagePaste: () => input.handleImagePaste(),
			handleImagePathPaste: (path: string) => input.handleImagePathPaste(path),
		});
		return harness;
	}

	async function until(check: () => boolean): Promise<void> {
		for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
		expect(check()).toBe(true);
	}

	it("attaches a pasted image to an ask note", async () => {
		const harness = imageHarness();
		const pending = harness.controller.showAskDialog(
			[{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
			{ acceptImages: true },
		);
		harness.term.press("n");
		await flushMicrotasks();
		expect(harness.ctx.promptPasteTarget).toBeDefined();
		harness.term.paste("");
		await until(() => harness.screen().includes("[Image #1"));
		harness.term.type(" see");
		harness.term.press("enter");
		await flushMicrotasks();
		expect(harness.ctx.promptPasteTarget).toBeUndefined();
		harness.term.press("enter");
		const result = await pending;
		const answer = result?.kind === "submit" ? result.results[0] : undefined;
		expect(answer?.note).toMatch(/^\[Image #1[^\]]*\] see$/);
		expect(answer?.noteImages).toHaveLength(1);
	});

	it("attaches a pasted image to a form option's note", async () => {
		const harness = imageHarness();
		const pending = harness.controller.showFormDialog(
			`<form><fieldset><legend>Database</legend>
				<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
				<label><input type="radio" name="db" value="postgres"> Postgres</label>
			</fieldset></form>`,
			{ acceptImages: true },
		);
		harness.term.press("n");
		expect(harness.ctx.promptPasteTarget).toBeDefined();
		harness.term.paste("");
		await until(() => harness.screen().includes("[Image #1"));
		harness.term.press("enter");
		expect(harness.ctx.promptPasteTarget).toBeUndefined();
		harness.term.press("tab");
		harness.term.press("enter");
		const result = await pending;
		expect(result?.notes?.[0]?.text).toMatch(/^\[Image #1[^\]]*\]$/);
		expect(result?.notes?.[0]?.images).toHaveLength(1);
	});
});

describe("ExtensionUiController editor UI", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hands the terminal to the external editor from an editor dialog and takes its text back", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		let suspended = false;
		harness.ctx.suspend = async run => {
			suspended = true;
			try {
				return await run();
			} finally {
				suspended = false;
			}
		};
		let ranSuspended: boolean | undefined;
		spyOn(externalEditor, "getEditorCommand").mockReturnValue("vim");
		const openInEditor = spyOn(externalEditor, "openInEditor").mockImplementation(async (_command, text) => {
			ranSuspended = suspended;
			return `${text} world`;
		});

		const pending = ui.editor("Focus", "hello");
		await flushMicrotasks();
		harness.term.press("ctrl+g");
		await flushMicrotasks();
		expect(openInEditor).toHaveBeenCalledWith("vim", "hello");
		// omp must not draw over the editor or read its keys while it runs.
		expect(ranSuspended).toBe(true);

		harness.term.press("ctrl+q");
		expect(await pending).toBe("hello world");
	});

	it("pastes and sets the composer's text for extensions", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");
		expect(harness.composer.text()).toBe("hello world");
		expect(ui.getEditorText()).toBe("hello world");

		ui.setEditorText("replaced");
		expect(harness.composer.text()).toBe("replaced");
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);
		expect(harness.ctx.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});

	it("exposes the composer hooks: key handlers run before the composer's bindings", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const seen: string[] = [];
		const remove = ui.composer!.addKeyHandler(key => {
			seen.push(key.id);
			return key.id === "x";
		});
		harness.term.type("xy");
		expect(seen).toEqual(["x", "y"]);
		expect(harness.composer.text()).toBe("y");
		remove();
		harness.term.type("x");
		expect(seen).toEqual(["x", "y"]);
	});

	it("shows line and view widgets above and below the composer", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		ui.setWidget("lines", ["first widget line"]);
		ui.setWidget("rows", () => ({ render: () => ["rows widget"] }), { placement: "belowEditor" });
		const screen = harness.screen();
		expect(screen).toContain("first widget line");
		expect(screen).toContain("rows widget");
		expect(harness.ctx.hud.widgets.above().map(entry => entry.key)).toEqual(["lines"]);
		expect(harness.ctx.hud.widgets.below().map(entry => entry.key)).toEqual(["rows"]);

		ui.setWidget("lines", undefined);
		expect(harness.ctx.hud.widgets.above()).toEqual([]);
		expect(harness.screen()).not.toContain("first widget line");
	});

	it("hands raw terminal input to extension listeners, which can consume it", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const seen: string[] = [];
		const stop = ui.onTerminalInput(data => {
			seen.push(data);
			return data === "a" ? { consume: true } : undefined;
		});
		harness.term.type("ab");
		harness.term.paste("pasted");
		expect(seen).toEqual(["a", "b", "\x1b[200~pasted\x1b[201~"]);
		expect(harness.composer.text()).toStartWith("b");
		stop();
		harness.term.type("c");
		expect(seen).toHaveLength(3);
	});
	it("feeds a listener's rewritten input to older listeners and the focused composer", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const older: string[] = [];
		ui.onTerminalInput(data => {
			older.push(data);
			return undefined;
		});
		ui.onTerminalInput(data => {
			if (data === "x") return { data: "yz" };
			if (data === "q") return { data: "" };
			return undefined;
		});
		harness.term.type("axq");
		expect(older).toEqual(["a", "y", "z"]);
		expect(harness.composer.text()).toStartWith("ayz");
		expect(harness.composer.text()).not.toContain("q");
	});
});

describe("ExtensionUiController custom view", () => {
	it("mounts a rows view in the composer's place with the keys; done resolves and restores the composer", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const typed: string[] = [];
		let finish: ((value: string) => void) | undefined;
		const pending = ui.custom<string>((_ui, _theme, _kb, done) => {
			finish = done;
			return {
				render: width => [`custom view ${width}`],
				handleInput: data => typed.push(data),
			} satisfies ExtensionRows;
		});
		await flushMicrotasks();
		expect(harness.ctx.showEditorAreaDialog).toHaveBeenCalledTimes(1);
		expect(harness.screen()).toContain("custom view");
		harness.term.type("q");
		expect(typed).toEqual(["q"]);

		finish!("answer");
		expect(await pending).toBe("answer");
		expect(harness.composerFocused()).toBe(true);
		expect(harness.screen()).not.toContain("custom view");
	});

	it("shows an overlay and hands its handle to onHandle", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const onHandle = vi.fn();
		void ui.custom<void>(() => ({ render: () => ["overlay view"] }), { overlay: true, onHandle });
		await flushMicrotasks();
		expect(harness.ctx.shell.overlays.open()).toBe(true);
		expect(onHandle).toHaveBeenCalledTimes(1);
		const handle = onHandle.mock.calls[0]![0] as { closed: boolean; close(): void };
		expect(handle.closed).toBe(false);
		handle.close();
		expect(handle.closed).toBe(true);
		expect(harness.ctx.shell.overlays.open()).toBe(false);
	});

	it("rejects when a custom factory fails, leaving the composer in place", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const failure = new Error("custom factory failed");
		await expect(ui.custom(() => Promise.reject(failure))).rejects.toBe(failure);
		expect(harness.ctx.showEditorAreaDialog).not.toHaveBeenCalled();
		expect(harness.composerFocused()).toBe(true);
	});

	it("aborts a pending custom factory and disposes its late rows", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		harness.composer.setText("draft before factory");
		const abort = new AbortController();
		const factory = Promise.withResolvers<ExtensionRows>();
		const rows = { render: () => ["late"], dispose: vi.fn() };

		const pending = ui.custom(() => factory.promise, { signal: abort.signal });
		harness.composer.setText("draft typed while factory is pending");
		abort.abort();

		await expect(pending).rejects.toBe(abort.signal.reason);
		factory.resolve(rows);
		await flushMicrotasks();

		expect(rows.dispose).toHaveBeenCalledTimes(1);
		expect(harness.ctx.showEditorAreaDialog).not.toHaveBeenCalled();
		expect(harness.composer.text()).toBe("draft typed while factory is pending");
	});
});

describe("ExtensionUiController tool approval", () => {
	const prompt = {
		full: "Allow tool: bash\nCommand: rm -rf build",
		compact: "Allow tool: bash\nCommand: rm -rf build",
		toolName: "bash",
	};
	let now = 1_000;
	beforeEach(() => {
		now = 1_000;
		spyOn(Date, "now").mockImplementation(() => now);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the choices over the live composer: the arrows and Enter take the session approval", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval({
			...prompt,
			session: "Approve bash for this session",
		});
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.composerFocused()).toBe(false);
		now = 2_000;
		harness.term.press("down");
		harness.term.press("enter");
		expect(await pending).toBe("session");
		expect(harness.approvalSlot()).toBe(false);
		expect(harness.composerFocused()).toBe(true);
	});

	it("steers with bracketed paste on Enter instead of approving the armed default", async () => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.paste("don't run that");
		expect(harness.composer.text()).toBe("don't run that");
		harness.term.press("enter", { kind: "release" });
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
		expect(harness.approvalSlot()).toBe(true);
		harness.term.press("enter");
		expect(await pending).toBe("deny");
		expect(harness.agent.peekSteeringQueue()).toMatchObject([{ content: "don't run that" }]);
	});

	it.each(["Escape", "Deny button", "Deny choice"])("%s denies without sending or clearing the draft", async how => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("unfinished");
		const dialog = harness.ctx.shell.focused()!;
		if (how === "Escape") harness.term.press("escape");
		else if (how === "Deny button") {
			const actions = dialog.children().find(node => node.key() === "actions")!;
			const deny = actions.children().find(node => node.key() === "deny")!;
			bubbleEvent([dialog, actions, deny], { type: "action", key: "ask/actions/deny", act: "deny", mods: [] });
		} else {
			const choices = dialog.children().find(node => node.key() === "choices")!;
			bubbleEvent([dialog, choices], { type: "select", key: "ask/choices", item: "deny" });
		}
		expect(await pending).toBe("deny");
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
		expect(harness.composer.text()).toBe("unfinished");
		expect(harness.composerFocused()).toBe(true);
	});

	it("edits chips atomically and clears on Ctrl+C before returning Enter to the empty approval", async () => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		harness.composer.setText("keep ");
		harness.composer.insertTextAttachment("discard this attachment");
		// Composer-slot shortcuts must not intercept edits while a dialog owns that slot.
		harness.composer.addKeyHandler(key => key.id === "backspace");
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.press("left"); // Before the space after the chip.
		harness.term.press("backspace");
		expect(harness.composer.chips()).toHaveLength(0);
		expect(harness.composer.text()).toBe("keep  ");
		harness.term.press("ctrl+c", { kind: "release" });
		expect(harness.composer.text()).toBe("keep  ");
		harness.term.press("ctrl+c");
		expect(harness.composer.text()).toBe("");
		expect(harness.approvalSlot()).toBe(true);
		harness.term.press("enter");
		expect(await pending).toBe("once");
		expect(harness.agent.peekSteeringQueue()).toHaveLength(0);
	});

	it("holds an armed Enter behind a pending clipboard paste while the approval owns the composer", async () => {
		const harness = makeHarness();
		Object.assign(harness.ctx.session, { prewarmModelConnection: () => {} });
		const clipboard = Promise.withResolvers<string>();
		new InputController(harness.ctx, {
			readMacFileUrls: async () => [],
			readImage: async () => null,
			readText: () => clipboard.promise,
			isTerminalLocal: () => true,
		}).setupKeyHandlers();
		harness.steerOnSubmit();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.paste("");
		harness.term.press("enter");
		expect(harness.approvalSlot()).toBe(true);
		clipboard.resolve("stop this call");
		expect(await pending).toBe("deny");
		expect(harness.agent.peekSteeringQueue()).toMatchObject([{ content: "stop this call" }]);
	});

	it("owns the composer while mounted and releases it when it settles", async () => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		expect(harness.ctx.composerOwner?.node).toBe(harness.ctx.shell.focused()!);
		expect(harness.ctx.composerOwner?.owns()).toBe(true);
		expect(harness.ctx.approvalOwnsComposer).toBe(true);

		harness.term.type("stop");
		harness.term.press("enter");
		expect(await pending).toBe("deny");
		expect(harness.ctx.composerOwner).toBeUndefined();
		expect(harness.ctx.approvalOwnsComposer).toBe(false);
	});

	it("Ctrl+Enter with an empty composer approves outright", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.steerCalls).toHaveLength(0);
		expect(harness.steering).toHaveLength(0);
	});

	it("Ctrl+Enter with a draft sends the note naming the call it approves, and settles without denying itself", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("watch the build");
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.composer.text()).toBe("");
		expect(harness.steerCalls).toEqual([
			{
				text: "watch the build",
				images: undefined,
				options: expect.objectContaining({ attribution: "user" }),
			},
		]);
		expect(harness.steerCalls[0]!.options!.approvalLine).toContain("`bash`");
		expect(harness.agent.peekSteeringQueue()).toHaveLength(1);
	});

	it("approve chord does not deny the other approvals queued in the same batch", async () => {
		const harness = makeHarness();
		const first = harness.controller.showCollabAwareApproval(prompt);
		const second = harness.controller.showCollabAwareApproval({ ...prompt, toolName: "write" });
		now = 2_000;
		harness.term.type("note");
		harness.term.press("ctrl+enter");
		expect(await first).toBe("once");
		// The note is the chord's own steer, not a deny: the next prompt stays up.
		await flushMicrotasks();
		expect(harness.approvalSlot()).toBe(true);
		now = 3_000;
		harness.term.press("ctrl+enter");
		expect(await second).toBe("once");
		expect(harness.steerCalls).toHaveLength(1);
	});

	it("ignores the approve chord while a raw paste is landing", async () => {
		const harness = makeHarness();
		const clipboard = Promise.withResolvers<string>();
		const input = new InputController(harness.ctx, {
			readImage: async () => null,
			readText: () => clipboard.promise,
			readMacFileUrls: async () => [],
			isTerminalLocal: () => true,
		});
		input.setupKeyHandlers();
		harness.ctx.handleClipboardTextRawPaste = () => input.handleClipboardTextRawPaste();
		harness.ctx.pasteInFlight = () => input.pasteInFlight();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		const pasting = harness.ctx.handleClipboardTextRawPaste();
		harness.term.press("ctrl+enter");
		await flushMicrotasks();
		// A paste still landing is a draft that isn't finished: the chord waits for it.
		expect(input.pasteInFlight()).toBe(true);
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.steerCalls).toHaveLength(0);
		clipboard.resolve("watch the build");
		await pasting;
		// The held chord replays once the paste lands, with the pasted note in hand.
		expect(await pending).toBe("once");
		expect(harness.steerCalls).toEqual([{ text: "watch the build", images: undefined, options: expect.anything() }]);
	});

	it("leaves the approval pending when the chord dispatches a command instead of steering", async () => {
		const harness = makeHarness();
		harness.ctx.submitApprovalNote = async () => "dispatched";
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("/settings");
		harness.term.press("ctrl+enter");
		await flushMicrotasks();
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.steerCalls).toHaveLength(0);
		expect(harness.composer.text()).toBe("");
		harness.term.press("escape");
		expect(await pending).toBe("deny");
	});

	it("returns focus to the approval after an editor-area dialog closes", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		const approval = harness.ctx.shell.focused();
		expect(harness.ctx.shell.home()).toBe(approval);
		const dialog = harness.ctx.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		expect(harness.ctx.shell.focused()).toBe(dialog.node);
		dialog.close();
		expect(harness.ctx.shell.focused()).toBe(approval);
		expect(harness.ctx.shell.home()).toBe(approval);
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.ctx.shell.focused()).toBe(harness.composer.field);
	});

	it("an editor-area dialog closing over an approval leaves Escape as deny", async () => {
		const harness = makeHarness();
		const abort = vi.spyOn(harness.ctx.session, "abort");
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		const approval = harness.ctx.shell.focused();
		const dialog = harness.ctx.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		expect(harness.ctx.shell.focused()).toBe(dialog.node);
		dialog.close();
		expect(harness.ctx.shell.focused()).toBe(approval);
		harness.term.press("escape");
		expect(await pending).toBe("deny");
		expect(harness.ctx.session.isAborting).toBe(false);
		expect(abort).not.toHaveBeenCalled();
		expect(harness.ctx.shell.focused()).toBe(harness.composer.field);
	});

	it("leaves focus on an open editor-area dialog when the approval settles under it", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		const pending = harness.controller.showCollabAwareApproval(prompt, { signal: abort.signal });
		now = 2_000;
		const dialog = harness.ctx.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		expect(harness.ctx.shell.focused()).toBe(dialog.node);
		abort.abort();
		await pending;
		expect(harness.approvalSlot()).toBe(false);
		// The approval went away while the dialog held the keys: the dialog keeps them.
		expect(harness.ctx.shell.focused()).toBe(dialog.node);
		dialog.close();
		expect(harness.ctx.shell.focused()).toBe(harness.composer.field);
	});

	it("holds the countdown while a dispatched command owns the keys, and resumes after it settles", async () => {
		// The dialog's countdown is a timer; run it on a fake clock so the test never sleeps on
		// wall time. The countdown is longer than the arm window, so advancing past the window
		// cannot deny the call the test is still waiting on.
		vi.useFakeTimers({ now: 0 });
		try {
			const harness = makeHarness();
			const onTimeout = vi.fn();
			const dispatch = Promise.withResolvers<ApprovalSubmitOutcome>();
			harness.ctx.submitApprovalNote = () => dispatch.promise;
			const pending = harness.controller.showCollabAwareApproval(prompt, { timeout: APPROVE_ARM_MS * 2, onTimeout });
			harness.term.type("what does /settings say about the model?");
			harness.term.press("ctrl+enter");
			// Inside the arm window: ignored, and the countdown has not run out.
			expect(harness.approvalSlot()).toBe(true);
			vi.advanceTimersByTime(APPROVE_ARM_MS + 1);
			expect(onTimeout).not.toHaveBeenCalled();
			harness.term.press("ctrl+enter");
			vi.advanceTimersByTime(60); // past the countdown, while the command owns the keys
			await settleChord();
			expect(onTimeout).not.toHaveBeenCalled();
			// A second chord while the command runs answers nothing.
			harness.term.press("ctrl+enter");
			expect(harness.approvalSlot()).toBe(true);
			expect(harness.steerCalls).toHaveLength(0);
			dispatch.resolve("dispatched");
			await settleChord();
			expect(harness.approvalSlot()).toBe(true);
			vi.advanceTimersByTime(APPROVE_ARM_MS * 2); // the countdown resumes for whatever comes next
			await settleChord();
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(await pending).toBe("deny");
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the approval pending when the chord's steer fails", async () => {
		const harness = makeHarness();
		// The session refuses the note: the chord must report it and hand the draft back.
		Object.assign(harness.ctx.session, {
			steer: async () => {
				throw new Error("queue rejected");
			},
		});
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("watch the build");
		harness.term.press("ctrl+enter");
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.ctx.showError).toHaveBeenCalledWith("queue rejected");
		expect(harness.composer.text()).toBe("watch the build");
		harness.term.press("escape");
		expect(await pending).toBe("deny");
	});

	it("keeps the approval pending when the chord sends an empty queue shorthand", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("/queue");
		harness.term.press("ctrl+enter");
		await flushMicrotasks();
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.steerCalls).toHaveLength(0);
		expect(harness.composer.text()).toBe("/queue");
		harness.term.press("escape");
		expect(await pending).toBe("deny");
	});

	it("dismisses the completion popup when approving and steering", async () => {
		const harness = makeHarness();
		harness.composer.setAutocomplete({
			applyCompletion: (_lines, _cursorLine, _cursorCol, item) => ({
				lines: [item.value],
				cursorLine: 0,
				cursorCol: item.value.length,
			}),
			getSuggestions: async () => ({ items: [{ value: "/skills", label: "/skills" }], prefix: "/sk" }),
			trySyncSlashCompletion: before =>
				before.startsWith("/sk") ? { items: [{ value: "/skills", label: "/skills" }], prefix: "/sk" } : null,
		});
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("/sk");
		await flushMicrotasks();
		expect(harness.composer.completing()).toBe(true);
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		// The chord clears the composer before dispatch; that is what keeps the popup from surviving it.
		expect(harness.composer.completing()).toBe(false);
	});

	it("lets the composer steer while a call waits: the queued message denies the call", async () => {
		const harness = makeHarness();
		// A steer queued before the prompt appeared does not answer it.
		harness.queueSteer("earlier message");
		harness.steerOnSubmit();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		// An Enter as the prompt appears is ignored: the dialog stays up.
		harness.term.press("enter");
		expect(harness.approvalSlot()).toBe(true);
		harness.term.type("keep the build dir");
		expect(harness.composer.text()).toBe("keep the build dir");
		harness.term.press("enter");
		expect(await pending).toBe("deny");
		expect(harness.approvalSlot()).toBe(false);
		expect(harness.composerFocused()).toBe(true);
		// One-at-a-time delivery takes the head at the batch boundary: the denying steer goes first.
		expect(harness.agent.peekSteeringQueue().map(message => message.role === "user" && message.content)).toEqual([
			"keep the build dir",
			"earlier message",
		]);
	});

	it("one steer denies every approval of the batch, including those queued behind the shown one", async () => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		const first = harness.controller.showCollabAwareApproval(prompt);
		const second = harness.controller.showCollabAwareApproval({ ...prompt, full: "Allow tool: write" });
		harness.term.type("stop");
		harness.term.press("enter");
		expect(await first).toBe("deny");
		expect(await second).toBe("deny");
		expect(harness.approvalSlot()).toBe(false);
	});

	it("a steer also denies approvals its batch requests later, until it is delivered", async () => {
		const harness = makeHarness();
		harness.steerOnSubmit();
		const first = harness.controller.showCollabAwareApproval(prompt);
		harness.term.type("stop");
		harness.term.press("enter");
		expect(await first).toBe("deny");
		expect(await harness.controller.showCollabAwareApproval(prompt)).toBe("deny");
		harness.deliverSteering();
		void harness.controller.showCollabAwareApproval(prompt);
		expect(harness.approvalSlot()).toBe(true);
	});

	it("denies when the countdown runs out", async () => {
		const harness = makeHarness();
		const onTimeout = vi.fn();
		const answer = await harness.controller.showCollabAwareApproval(prompt, { timeout: 10, onTimeout });
		expect(answer).toBe("deny");
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(harness.approvalSlot()).toBe(false);
	});
});

describe("ExtensionUiController hook dialogs", () => {
	it("mounts the selector in the composer's place and restores the composer when it settles", async () => {
		const harness = makeHarness();
		const answer = harness.controller.showHookSelector("Pick one", ["Alpha", "Beta"]);
		expect(harness.ctx.hookSelector).toBeDefined();
		expect(harness.composerFocused()).toBe(false);
		harness.term.press("down");
		harness.term.press("enter");
		expect(await answer).toBe("Beta");
		expect(harness.ctx.hookSelector).toBeUndefined();
		expect(harness.composerFocused()).toBe(true);
	});

	it("serializes dialogs: a second one waits for the first", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const first = ui.confirm("First?", "one");
		const second = ui.input("Second?");
		expect(harness.ctx.hookInput).toBeUndefined();
		harness.term.press("enter");
		expect(await first).toBe(true);
		expect(harness.ctx.hookInput).toBeDefined();
		harness.term.type("typed");
		harness.term.press("enter");
		expect(await second).toBe("typed");
		expect(harness.composerFocused()).toBe(true);
	});
});

describe("ExtensionUiController dialog serialization", () => {
	it("queues a second selector instead of clobbering the open one", async () => {
		const harness = makeHarness();
		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = harness.controller.showHookSelector("A", ["a1", "a2"], { signal: abortA.signal });
		// The first dialog is presented synchronously in the composer's place.
		const dialogA = harness.ctx.hookSelector;
		expect(dialogA).toBeDefined();

		const promiseB = harness.controller.showHookSelector("B", ["b1", "b2"], { signal: abortB.signal });
		// The second request must not take the place while A is open — orphaning A is the hang this prevents.
		expect(harness.ctx.hookSelector).toBe(dialogA);

		// Settling A hands the place to the queued B.
		abortA.abort();
		expect(await promiseA).toBeUndefined();
		expect(dialogA!.closed).toBe(true);
		const dialogB = harness.ctx.hookSelector;
		expect(dialogB).toBeDefined();
		expect(dialogB).not.toBe(dialogA);

		// Settling B gives the composer its place back.
		abortB.abort();
		expect(await promiseB).toBeUndefined();
		expect(harness.ctx.hookSelector).toBeUndefined();
		expect(harness.composerFocused()).toBe(true);
	});

	it("never presents a queued selector whose signal aborts before its turn", async () => {
		const harness = makeHarness();
		const abortA = new AbortController();
		const abortB = new AbortController();

		const promiseA = harness.controller.showHookSelector("A", ["a1"], { signal: abortA.signal });
		const dialogA = harness.ctx.hookSelector;
		const promiseB = harness.controller.showHookSelector("B", ["b1"], { signal: abortB.signal });

		abortB.abort();
		expect(await promiseB).toBeUndefined();
		expect(harness.ctx.hookSelector).toBe(dialogA);

		abortA.abort();
		expect(await promiseA).toBeUndefined();
		expect(harness.ctx.hookSelector).toBeUndefined();
		expect(harness.ctx.showEditorAreaDialog).toHaveBeenCalledTimes(1);
		expect(harness.composerFocused()).toBe(true);
	});

	it("dismisses a confirmation and restores the composer when its signal aborts", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		const result = harness.controller.showHookConfirm("High-risk command", "Allow this command?", {
			signal: abort.signal,
		});
		expect(harness.ctx.hookSelector).toBeDefined();
		abort.abort();
		expect(await result).toBe(false);
		expect(harness.ctx.hookSelector).toBeUndefined();
		expect(harness.composerFocused()).toBe(true);
	});

	it("hides the hook editor and resolves undefined when the caller aborts", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		const result = harness.controller.showHookEditor("Edit", "prefill", { signal: abort.signal });
		const dialog = harness.ctx.hookEditor;
		expect(dialog).toBeDefined();
		abort.abort();
		expect(await result).toBeUndefined();
		expect(dialog!.closed).toBe(true);
		expect(harness.ctx.hookEditor).toBeUndefined();
		expect(harness.composerFocused()).toBe(true);
	});

	it("submits a prompt-style hook editor on Enter", async () => {
		const harness = makeHarness();
		const result = harness.controller.showHookEditor("Ask prompt", undefined, undefined, { promptStyle: true });
		harness.term.type("answer");
		harness.term.press("enter");
		expect(await result).toBe("answer");
	});
});

describe("ExtensionUiController OSC 7501 run status", () => {
	const report = (body: string) => `\x1b]7501;${body}\x1b\\`;
	const blocked = (kind: "permission" | "question", msg: string) =>
		report(`state=blocked:kind=${kind}:app=omp:msg=${Buffer.from(msg).toString("base64")}`);
	let writes: string[] = [];
	let prevHeadless = false;
	let ttyDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		prevHeadless = setTerminalHeadless(false);
		ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		writes = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array));
			return true;
		});
		initProgramStatus();
		setProgramStatusEnabled(true);
		setRunStatus({ state: "working" });
		writes.length = 0;
	});

	afterEach(() => {
		disposeProgramStatus();
		vi.restoreAllMocks();
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		setTerminalHeadless(prevHeadless);
	});

	it("reports a hook confirm as blocked on permission until answered, also across a settled run", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		const answer = ui.confirm("Run terraform apply?", "This changes production.");
		expect(writes).toEqual([blocked("permission", "Run terraform apply? This changes production.")]);

		// The run settles while the dialog still waits: the dialog keeps the record.
		setRunStatus({ state: "done" });
		expect(writes).toHaveLength(1);

		harness.term.press("enter");
		expect(await answer).toBe(true);
		expect(writes.slice(1)).toEqual([report("state=done:app=omp")]);
	});

	it("hands the record to the next queued dialog without reporting completion between prompts", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const first = ui.confirm("Approve deployment?", "terraform apply");
		const second = ui.input("Deployment reason?");
		setRunStatus({ state: "done" });

		harness.term.press("enter");
		expect(await first).toBe(true);
		expect(writes).toEqual([
			blocked("permission", "Approve deployment? terraform apply"),
			blocked("question", "Deployment reason?"),
		]);

		harness.term.press("escape");
		expect(await second).toBeUndefined();
		expect(writes.at(-1)).toBe(report("state=done:app=omp"));
	});

	it("reports a tool approval as blocked on permission and releases it when the call aborts", async () => {
		const harness = makeHarness();
		const ui = await harness.init();
		const abort = new AbortController();

		const answer = ui.approve!(
			{ full: "Allow tool: bash\nCommand: gh pr merge", compact: "Allow tool: bash\nCommand: gh pr merge" },
			{ signal: abort.signal },
		);
		expect(writes).toEqual([blocked("permission", "Allow tool: bash Command: gh pr merge")]);

		abort.abort();
		expect(await answer).toBe("deny");
		expect(writes.slice(1)).toEqual([report("state=working:app=omp")]);
	});

	it("reports a selector that asks for a permission (a cfg:// change) as blocked on permission", async () => {
		const harness = makeHarness();
		await harness.init();

		const answer = harness.controller.showCollabAwareSelector(
			"Your agent wants to change tui.theme",
			["Approve", "Deny"],
			undefined,
			{ kind: "permission" },
		);
		expect(writes).toEqual([blocked("permission", "Your agent wants to change tui.theme")]);

		harness.term.press("escape");
		expect(await answer).toBeUndefined();
	});
});
