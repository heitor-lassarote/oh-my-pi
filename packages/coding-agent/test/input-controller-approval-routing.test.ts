/**
 * A tool approval waiting in the main session keeps the composer mounted, and a
 * message typed there steers the turn that asked, denying the call. When the
 * user is viewing a subagent, that submission must still reach the main
 * session: sent to the focused child, it never denies the approval.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as builtinSlashCommands from "../src/slash-commands/builtin-registry";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { ApprovalSubmitOptions, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Composer } from "../src/ui/composer/composer";

afterEach(() => {
	vi.restoreAllMocks();
});

function createContext(approvalOwnsComposer: boolean, collabGuest?: { readOnly: boolean }) {
	const composer = new Composer();
	const mainPrompt = vi.fn(async () => true);
	const focusedPrompt = vi.fn(async () => true);
	const setLoopPrompt = vi.fn();
	const ctx = {
		composer,
		keybindings: KeybindingsManager.inMemory(),
		settings: Settings.isolated(),
		session: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner: undefined,
			customCommands: [],
			promptTemplates: [],
			slashCommands: [],
			prompt: mainPrompt,
			followUp: vi.fn(async () => {}),
			hasInterruptibleInput: false,
			resolveModelMention: () => undefined,
			modelMentions: [],
		},
		viewSession: { isStreaming: false, queuedMessageCount: 0, prompt: focusedPrompt, abort: vi.fn(async () => {}) },
		focusedAgentId: "Worker",
		approvalOwnsComposer,
		collabGuest,
		setLoopPrompt,
		sessionManager: { putBlob: vi.fn(), getSessionId: () => "test-session" },
		loopModeEnabled: false,
		flushPendingExecRuns: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		handleBashCommand: vi.fn(),
		queueCompactionMessage: vi.fn(),
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		isBtwFocused: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return { ctx, composer, mainPrompt, focusedPrompt, setLoopPrompt };
}

describe("approval composer routing from a focused view", () => {
	it("steers the main session while its approval owns the composer, else the focused agent", async () => {
		for (const owned of [true, false]) {
			const { ctx, mainPrompt, focusedPrompt } = createContext(owned);
			const controller = new InputController(ctx);
			controller.setupEditorSubmitHandler();

			ctx.composer.onSubmit?.("keep the build dir");
			await controller.waitForSubmissionDispatches();

			expect(mainPrompt).toHaveBeenCalledTimes(owned ? 1 : 0);
			expect(focusedPrompt).toHaveBeenCalledTimes(owned ? 0 : 1);
		}
	});
});

describe("approval chord outcome mapping", () => {
	it("plain note queues a steer and reports steered", async () => {
		const { ctx, mainPrompt } = createContext(true);
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("keep the build dir", approval);
		expect(outcome).toBe("steered");
		expect(approval.steer).toHaveBeenCalledWith("keep the build dir", undefined);
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("queue shorthand from a chord steers its body", async () => {
		const { ctx, mainPrompt } = createContext(true);
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("-> wait for the tests", approval);
		expect(outcome).toBe("steered");
		expect(approval.steer).toHaveBeenCalledWith("wait for the tests", undefined);
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("bare shorthand from a chord keeps the approval pending and restores the draft", async () => {
		const { ctx, mainPrompt } = createContext(true);
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("->", approval);
		expect(outcome).toBe("kept");
		expect(approval.steer).not.toHaveBeenCalled();
		expect(mainPrompt).not.toHaveBeenCalled();
		expect(ctx.composer.text()).toBe("->");
	});

	it("the chord does not arm loop mode", async () => {
		const { ctx, setLoopPrompt } = createContext(true);
		ctx.loopModeEnabled = true;
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockResolvedValue("fix the build");
		const outcome = await new InputController(ctx).submitApprovalNote("/loop fix the build", approval);
		expect(outcome).toBe("steered");
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(approval.steer).toHaveBeenCalledWith("fix the build", undefined);
	});

	it("a dispatched command reports dispatched and does not steer", async () => {
		const { ctx, mainPrompt } = createContext(true);
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockResolvedValue(true);
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("/settings", approval);
		expect(outcome).toBe("dispatched");
		expect(approval.steer).not.toHaveBeenCalled();
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("a read-only guest reports kept and sends nothing", async () => {
		const { ctx, mainPrompt } = createContext(true, { readOnly: true });
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("watch the build", approval);
		expect(outcome).toBe("kept");
		expect(approval.steer).not.toHaveBeenCalled();
		expect(mainPrompt).not.toHaveBeenCalled();
	});

	it("a throwing command reports kept and restores the draft", async () => {
		const { ctx } = createContext(true);
		const setCollapsedText = vi.spyOn(ctx.composer, "setCollapsedText");
		vi.spyOn(builtinSlashCommands, "executeBuiltinSlashCommand").mockRejectedValueOnce(
			new Error("security export needs --output"),
		);
		const approval: ApprovalSubmitOptions = { steer: vi.fn(async () => {}) };
		const outcome = await new InputController(ctx).submitApprovalNote("/security export", approval);
		expect(outcome).toBe("kept");
		expect(ctx.showError).toHaveBeenCalledWith("security export needs --output");
		expect(setCollapsedText).toHaveBeenCalledWith("/security export");
		expect(approval.steer).not.toHaveBeenCalled();
	});
});
