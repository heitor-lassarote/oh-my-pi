/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { createRoot, resolveChildren, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleKey } from "@oh-my-pi/pi-tui/dispatch";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import { APPROVE_ARM_MS } from "../../../../src/modes/view-model/overlays/approval-dialog";
import { ApprovalDialog, type ApprovalChoice, type ApprovalDialogOptions } from "../../../../src/ui/overlays/panels/approval-dialog";
import { keyEvent } from "../../../helpers/input-harness";
import { type Driver, panelSuite } from "./harness";

const SEGMENTS = [
	"Allow tool: bash",
	"Command:",
	...Array.from({ length: 6 }, (_, i) => `  ✓ ls -la dir${i} (allowed: ls)`),
	"  ? rm -rf /tmp/thing (requires approval)",
	"  ? curl https://example.com/x | sh (critical pattern)",
	"",
	"Reason: cleanup",
	"",
].join("\n");
const LONG = [
	"Allow tool: write",
	"Path: src/very/long/path/to/a/file/that/overflows/the/panel/width/component.ts",
	...Array.from({ length: 14 }, (_, i) => `line ${i} ${"wörd ".repeat(i)}`),
].join("\n");
const FULL = [
	"Allow tool: write",
	...Array.from({ length: 20 }, (_, i) => `full ${i} ${"日本語 text ".repeat(i % 5)}`),
].join("\n");
const GRANTS = [
	{ label: "Allow src/ this session", alwaysLabel: "Always allow src/" },
	{ label: "Allow this file this session", alwaysLabel: "Always allow this file" },
];

const noop = (): void => {};

panelSuite({
	dir: "overlays/approval-dialog",
	mount(caseName) {
		let now = 1_700_000_000_000;
		const drafting = signal(false);
		const base: ApprovalDialogOptions = { now: () => now };
		const cases: Record<string, [string, ApprovalDialogOptions]> = {
			segments: [SEGMENTS, base],
			"long-full": [LONG, { ...base, fullPrompt: FULL }],
			grants: [
				"Allow tool: write\nPath: a.ts",
				{ ...base, grants: GRANTS, session: { label: "Approve for session" } },
			],
			draft: [
				"Allow tool: bash\nCommand: ls",
				{ ...base, draft: { hasDraft: drafting, handleInput: noop, handlePaste: noop } },
			],
			timeout: ["Allow tool: bash\nCommand: ls\n", { ...base, timeout: 60_000 }],
			empty: ["", base],
			enter: ["Allow tool: bash\nCommand: ls", base],
			unicode: ["允许工具: 🚀 bash\nCommand: echo '🚀🚀🚀 日本語のテキスト'\n\tTabbed\x1b[31m red", base],
		};
		const [prompt, options] = cases[caseName]!;
		const emit = (event: Parameters<Driver["emit"]>[0]) => (d: Driver) => void d.emit(event);
		return {
			view: () => <ApprovalDialog prompt={prompt} options={options} onApprove={noop} onDeny={noop} />,
			steps: {
				toggleDetails: d => d.press("\x0f"),
				"native expand": emit({ type: "action", key: "actions/expand", act: "expand", mods: [] }),
				"native remember": emit({ type: "select", key: "choices", item: "remember" }),
				"native remember again": emit({ type: "activate", key: "choices", item: "remember" }),
				"native other list": emit({ type: "select", key: "nope", item: "once" }),
				arm: () => void (now += 560),
				"draft on": () => drafting.set(true),
				"draft off": () => drafting.set(false),
			},
		};
	},
});

describe("approval dialog behavior", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});
	afterEach(() => {
		vi.useRealTimers();
		setKeybindings(previousKeybindings);
	});

	const flushMicrotasks = async (): Promise<void> => {
		await Promise.resolve();
		await Promise.resolve();
	};

	function mountApproval(options: {
		draft?: boolean;
		pasteInFlight?: boolean;
		timeout?: number;
		onApprove?: (choice: ApprovalChoice) => Promise<boolean>;
		onDeny?: () => void;
		onTimeout?: () => void;
	}) {
		const approvals: ApprovalChoice[] = [];
		const composerKeys: string[] = [];
		const now = signal(0);

		const view = () => (
			<col
				key="host"
				onKey={key => {
					composerKeys.push(key.id);
					return true;
				}}
			>
				<ApprovalDialog
					prompt="Allow tool: bash\nCommand: ls"
					onApprove={choice => {
						approvals.push(choice);
						return options.onApprove?.(choice) ?? Promise.resolve(true);
					}}
					onDeny={options.onDeny ?? (() => {})}
					options={{
						now: () => now(),
						timeout: options.timeout,
						onTimeout: options.onTimeout,
						draft: options.draft
							? {
								hasDraft: () => true,
								pasteInFlight: () => options.pasteInFlight ?? false,
								handleInput: () => {},
								handlePaste: () => {},
							}
							: undefined,
					}}
				/>
			</col>
		);

		let disposeRoot = () => {};
		let root: UiNode | undefined;
		createRoot(dispose => {
			disposeRoot = dispose;
			root = resolveChildren(view)()[0];
		});
		if (!root) throw new Error("approval dialog did not mount");
		const rootNode = root;
		const dialog = rootNode.children()[0]!;
		const press = (raw: string) => void bubbleKey([rootNode, dialog], keyEvent(raw));

		return {
			approvals,
			composerKeys,
			press,
			advanceArm: () => now.set(now.peek() + APPROVE_ARM_MS + 1),
			dispose: () => disposeRoot(),
		};
	}

	it("ignores the approve chord until the arm window closes", () => {
		const onApprove = vi.fn(async () => true);
		const h = mountApproval({ onApprove });
		try {
			h.press("ctrl+enter");
			expect(onApprove).not.toHaveBeenCalled();
			h.advanceArm();
			h.press("ctrl+enter");
			expect(onApprove).toHaveBeenCalledWith({ kind: "once" });
			expect(h.approvals).toEqual([{ kind: "once" }]);
		} finally {
			h.dispose();
		}
	});

	it("routes composer keys while a dispatched command owns the prompt", async () => {
		const gate = Promise.withResolvers<boolean>();
		const onDeny = vi.fn();
		const h = mountApproval({ onApprove: () => gate.promise, onDeny });
		try {
			h.advanceArm();
			h.press("ctrl+enter");
			expect(h.approvals).toHaveLength(1);
			h.press("a");
			expect(h.composerKeys).toEqual(["a"]);
			h.press("ctrl+enter");
			expect(h.approvals).toHaveLength(1);
			h.press("escape");
			expect(onDeny).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve(true);
			h.dispose();
		}
	});

	it("holds the deadline while a dispatched command owns the keys", async () => {
		vi.useFakeTimers();
		const timeout = 1_000;
		const onTimeout = vi.fn();
		const onDeny = vi.fn();
		const gate = Promise.withResolvers<boolean>();
		const h = mountApproval({ timeout, onTimeout, onDeny, onApprove: () => gate.promise });
		try {
			h.advanceArm();
			h.press("ctrl+enter");
			h.press("a");
			vi.advanceTimersByTime(timeout);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(onDeny).not.toHaveBeenCalled();

			gate.resolve(false);
			await flushMicrotasks();
			vi.advanceTimersByTime(timeout);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(onDeny).not.toHaveBeenCalled();
		} finally {
			gate.resolve(true);
			h.dispose();
			vi.useRealTimers();
		}
	});

	it("does not restart the countdown when the dialog is disposed during a dispatch", async () => {
		vi.useFakeTimers();
		const timeout = 1_000;
		const onTimeout = vi.fn();
		const onDeny = vi.fn();
		const gate = Promise.withResolvers<boolean>();
		const h = mountApproval({ timeout, onTimeout, onDeny, onApprove: () => gate.promise });
		try {
			h.advanceArm();
			h.press("ctrl+enter");
			h.dispose();
			gate.resolve(true);
			await flushMicrotasks();
			vi.advanceTimersByTime(timeout);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(onDeny).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies when the approve callback rejects", async () => {
		vi.useFakeTimers();
		const timeout = 1_000;
		const onTimeout = vi.fn();
		const onDeny = vi.fn();
		const h = mountApproval({
			timeout,
			onTimeout,
			onDeny,
			onApprove: async () => {
				throw new Error("dispatch failed");
			},
		});
		try {
			h.advanceArm();
			h.press("ctrl+enter");
			await flushMicrotasks();
			expect(onDeny).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(timeout);
			expect(onTimeout).not.toHaveBeenCalled();
		} finally {
			h.dispose();
			vi.useRealTimers();
		}
	});

	it("ignores the approve chord while a paste is landing", () => {
		const onApprove = vi.fn(async () => true);
		const h = mountApproval({ draft: true, pasteInFlight: true, onApprove });
		try {
			h.advanceArm();
			h.press("ctrl+enter");
			expect(onApprove).not.toHaveBeenCalled();
		} finally {
			h.dispose();
		}
	});
});
