/**
 * `AgentSession.steer` must report the exact messages a caller queued before
 * queue listeners run. If the callback fires after the push, an approval chord
 * can see its own approval note and deny the call it just approved.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

async function createApprovalSession(): Promise<{ tempDir: TempDir; session: AgentSession }> {
	const tempDir = TempDir.createSync("@omp-approval-steer-");
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(createInMemoryAuthStorage(), path.join(tempDir.path(), "models.yml"), {
		settings,
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	// Keep the idle queue drain from starting a real model run in this test.
	session.setClientBridge({ capabilities: {}, deferAgentInitiatedTurns: true });

	return { tempDir, session };
}

describe("real session approval steer", () => {
	it("reports the approval note before the queue grows and stamps the approval line", async () => {
		const fixture = await createApprovalSession();
		try {
			let queueLengthWhenCalled = fixture.session.agent.peekSteeringQueue().length;
			let queued: readonly AgentMessage[] | undefined;

			await fixture.session.steer("approved because it only cleans build output", undefined, {
				approvalLine: "Approved the bash call.",
				onPromptQueued: messages => {
					queued = messages;
					queueLengthWhenCalled = fixture.session.agent.peekSteeringQueue().length;
				},
			});

			expect(queueLengthWhenCalled).toBe(0);
			expect(queued?.length).toBe(1);
			const message = fixture.session.agent.peekSteeringQueue()[0];
			if (message?.role !== "user") throw new Error("Expected a user steer");
			expect("approvalLine" in message ? message.approvalLine : undefined).toBe("Approved the bash call.");
		} finally {
			await fixture.session.dispose();
			fixture.tempDir.removeSync();
		}
	});
});
