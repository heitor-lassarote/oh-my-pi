/**
 * The approve chord (`app.approval.approve`) against a `/skill:` draft: dispatching the
 * skill answers the approval, while a plain note steers. The skill's own queued message
 * must not read as a deny, and a dispatch that throws must leave the prompt pending.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { join } from "node:path";
import { type AgentMessage, Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { jsx } from "@oh-my-pi/pi-tui";
import {
	getSkillSlashCommandName,
	loadSkillPrompt,
	renderSkillPromptMessage,
	type Skill,
} from "../../../src/extensibility/skills";
import type { ExtensionApprovalAnswer } from "../../../src/extensibility/extensions/types";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { InputController } from "../../../src/modes/controllers/input-controller";
import type { ApprovalSubmitOptions, ApprovalSubmitOutcome, InteractiveModeContext } from "../../../src/modes/types";
import { APPROVE_ARM_MS } from "../../../src/modes/view-model/overlays/approval-dialog";
import type { PromptOptions, SteerOptions } from "../../../src/session/agent-session-types";
import { initTheme } from "../../../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

/** `buildSkillCommandPrompt` needs a skill whose SKILL.md really exists. */
const skillDir = join(import.meta.dir, "../../fixtures/skills/valid-skill");
const skill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: join(skillDir, "SKILL.md"),
	baseDir: skillDir,
	source: "test",
} as Skill;
const skillCommandKey = getSkillSlashCommandName(skill);
const skillCommand = `/skill:${skill.name}`;

const prompt = {
	full: "Allow tool: bash\nCommand: rm -rf build",
	compact: "Allow tool: bash\nCommand: rm -rf build",
	toolName: "bash",
};

function makeHarness(harnessOptions: { skillDispatchFails?: boolean; inputHook?: (text: string) => string } = {}) {
	// A real agent-core queue: the approval's deny-watch tracks and reorders its steering messages.
	const agent = new Agent();
	/** The chord's own steer calls, without the skill dispatch. */
	const steerCalls: string[] = [];
	const skillMessages: { message: unknown; options: unknown }[] = [];
	// Resolves once a chord submit has run its whole dispatch path, error handling included.
	const chordSettled = Promise.withResolvers<ApprovalSubmitOutcome | void>();
	const steerMock = vi.fn(async (text: string, images?: ImageContent[], options?: SteerOptions) => {
		steerCalls.push(text);
		const message = { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
		options?.onPromptQueued?.([message]);
		agent.steer(message);
	});
	/** Skill dispatch pushes its custom message onto the steering queue, as the session would. */
	const promptCustomMessage = vi.fn(async (message: unknown, options?: PromptOptions) => {
		if (harnessOptions.skillDispatchFails) throw new Error("skill dispatch failed");
		skillMessages.push({ message, options });
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
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: agent.peekSteeringQueue(), followUp: [], liveSteered: 0 }),
			subscribe: ((listener: (event: { type: string; steering?: readonly AgentMessage[] }) => void) =>
				agent.onQueueChange(() =>
					listener({ type: "queue_update", steering: agent.peekSteeringQueue() }),
				)) as unknown as InteractiveModeContext["session"]["subscribe"],
			steer: steerMock as unknown as InteractiveModeContext["session"]["steer"],
			promptCustomMessage:
				promptCustomMessage as unknown as InteractiveModeContext["session"]["promptCustomMessage"],
			buildUserSkillPrompt: async (target: Skill, input: Parameters<typeof renderSkillPromptMessage>[1]) => {
				const loaded = await loadSkillPrompt(target);
				return {
					message: renderSkillPromptMessage(loaded.skill, input, loaded.body, "user", {}),
					details: undefined,
				};
			},
			extensionRunner: harnessOptions.inputHook
				? {
						hasHandlers: () => true,
						emitInput: async (text: string) => ({ text: harnessOptions.inputHook!(text) }),
					}
				: undefined,
		} as unknown as InteractiveModeContext["session"],
		skillCommands: new Map([[skillCommandKey, skill]]),
		renderOptimisticSkillMessage: vi.fn(),
		clearOptimisticSkillMessage: vi.fn(),
		optimisticSkillMessagePending: false,
		restoreDroppedPrompt: vi.fn(),
	});
	// The chord goes through the real submit path; the wrapper reports when it has settled.
	ctx.submitApprovalNote = async (text: string, options?: ApprovalSubmitOptions) => {
		try {
			const outcome = await new InputController(ctx, {
				readImage: async () => null,
				readText: async () => "",
			}).submitApprovalNote(text, options);
			chordSettled.resolve(outcome);
			return outcome;
		} finally {
			chordSettled.resolve();
		}
	};
	const term = attachTerminal(ctx);
	const controller = new ExtensionUiController(ctx);
	return {
		ctx,
		term,
		controller,
		agent,
		composer: ctx.composer,
		approvalSlot: () => ctx.shell.dock.slot("approval").occupied(),
		/** Settles once the chord's submit has run its whole dispatch path. */
		chordSettled: chordSettled.promise,
		get steering(): readonly AgentMessage[] {
			return agent.peekSteeringQueue();
		},
		get steerCalls() {
			return steerCalls;
		},
		get skillMessages() {
			return skillMessages;
		},
	};
}

let now = 1_000;
beforeEach(() => {
	now = 1_000;
	spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
	vi.restoreAllMocks();
});

/** Let a deep submit chain (hooks, dispatch, queue notifications) drain. */
async function settleChain(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("approve chord vs /skill dispatch", () => {
	it("dispatches the skill and settles the approval, without steering the raw slash text", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type(skillCommand);
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.skillMessages).toHaveLength(1);
		expect(harness.steerCalls).toEqual([]);
		expect(harness.composer.text()).toBe("");
		// The skill's message is the only thing on the queue.
		expect(harness.steering.map(message => message.role)).toEqual(["custom"]);
	});

	it("dispatches a skill chord after an editor-area dialog closes over the approval", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		const approval = harness.ctx.shell.focused();
		const dialog = harness.ctx.showEditorAreaDialog(() => jsx("text", { text: "modal" }));
		expect(harness.ctx.shell.focused()).toBe(dialog.node);
		dialog.close();
		expect(harness.ctx.shell.focused()).toBe(approval);
		harness.term.type(skillCommand);
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.skillMessages).toHaveLength(1);
		expect(harness.steerCalls).toEqual([]);
	});

	it("dispatches a collapsed skill chip", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		// Trailing whitespace collapses the token into an atom chip; the chord expands it back.
		harness.term.type(`${skillCommand} `);
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.skillMessages).toHaveLength(1);
		expect(harness.steerCalls).toEqual([]);
	});

	it("ignores the chord inside the arm window and dispatches after it", async () => {
		const harness = makeHarness();
		// The clock starts at 0, so the prompt's arm deadline is still in the future.
		now = 0;
		const pending = harness.controller.showCollabAwareApproval(prompt);
		harness.term.type(skillCommand);
		harness.term.press("ctrl+enter");
		await settleChain();
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.skillMessages).toHaveLength(0);
		// The chord ignored inside the arm window stays pending; the next one dispatches.
		now = APPROVE_ARM_MS + 1;
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.skillMessages).toHaveLength(1);
		expect(harness.steerCalls).toEqual([]);
	});

	it("treats the dispatched skill message as an answer, so it does not deny the next approval", async () => {
		const harness = makeHarness();
		const first = harness.controller.showCollabAwareApproval(prompt);
		const second = harness.controller.showCollabAwareApproval({ ...prompt, toolName: "write" });
		let secondAnswer: ExtensionApprovalAnswer | undefined;
		second.then(answer => {
			secondAnswer = answer;
		});
		now = 2_000;
		harness.term.type(skillCommand);
		harness.term.press("ctrl+enter");
		expect(await first).toBe("once");
		await settleChain();
		// The skill's queued message landed after the second prompt subscribed: the deny-watch
		// must read it as the answer it is, not as a steer against that call.
		expect(secondAnswer).toBeUndefined();
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.steerCalls).toEqual([]);
		harness.term.press("escape");
		expect(await second).toBe("deny");
	});

	it("keeps the approval pending when the skill dispatch throws", async () => {
		const harness = makeHarness({ skillDispatchFails: true });
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type(skillCommand);
		harness.term.press("ctrl+enter");
		// The dispatch reads a real SKILL.md: wait on the chord's own settle signal, not a guess.
		await harness.chordSettled;
		expect(harness.approvalSlot()).toBe(true);
		expect(harness.skillMessages).toHaveLength(0);
		expect(harness.steerCalls).toEqual([]);
		expect(harness.ctx.showError).toHaveBeenCalledWith("skill dispatch failed");
		expect(harness.composer.text()).toBe(skillCommand);
		harness.term.press("escape");
		expect(await pending).toBe("deny");
	});

	it("steers a note an input hook rewrote, with the approval line, and dispatches no skill", async () => {
		const harness = makeHarness({ inputHook: text => `rewritten: ${text}` });
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("fix the build");
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.steerCalls).toEqual(["rewritten: fix the build"]);
		expect(harness.skillMessages).toHaveLength(0);
	});

	it("sends c as a message, not a continue", async () => {
		const harness = makeHarness();
		const pending = harness.controller.showCollabAwareApproval(prompt);
		now = 2_000;
		harness.term.type("c");
		harness.term.press("ctrl+enter");
		expect(await pending).toBe("once");
		expect(harness.steerCalls).toEqual(["c"]);
		expect(harness.skillMessages).toHaveLength(0);
	});
});
