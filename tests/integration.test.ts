import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { TestParams } from "./helpers/test-workflow.ts";

type CallLog = {
	type: "run" | "undo";
	stepName: string;
	data: Record<string, unknown>;
};

async function getCallLogs(testId: string): Promise<CallLog[]> {
	const list = await env.CALL_LOG.list({ prefix: `${testId}:` });
	const logs: CallLog[] = [];

	for (const key of list.keys) {
		const value = await env.CALL_LOG.get(key.name);
		if (value) {
			const parts = key.name.split(":");
			const type = parts[2] as "run" | "undo";
			const stepName = parts[3] ?? "";
			logs.push({
				type,
				stepName,
				data: JSON.parse(value),
			});
		}
	}

	return logs;
}

function generateTestId(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type WorkflowResult = {
	testId: string;
	dispose: () => Promise<void>;
};

async function runWorkflow(
	params: Omit<TestParams, "testId">,
): Promise<WorkflowResult> {
	const testId = generateTestId();

	const introspector = await introspectWorkflowInstance(
		env.TEST_WORKFLOW,
		testId,
	);

	await env.TEST_WORKFLOW.create({
		id: testId,
		params: { ...params, testId },
	});

	// Wait for workflow to complete or error
	try {
		await introspector.waitForStatus("complete");
	} catch {
		await introspector.waitForStatus("errored");
	}

	return {
		testId,
		dispose: () => introspector.dispose(),
	};
}

describe("withRollback integration tests", () => {
	describe("sanity check", () => {
		it("basic step.do works (2-arg and 3-arg forms)", async () => {
			const { testId, dispose } = await runWorkflow({ scenario: "basic-step" });

			try {
				const logs = await getCallLogs(testId);
				expect(logs).toHaveLength(2);
				expect(logs[0]?.stepName).toBe("basic");
				expect(logs[1]?.stepName).toBe("basic-with-config");
			} finally {
				await dispose();
			}
		});

		it("ctx.do passthrough works", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "ctx-do-passthrough",
			});

			try {
				const logs = await getCallLogs(testId);
				expect(logs).toHaveLength(1);
				expect(logs[0]?.stepName).toBe("ctx-do-test");
			} finally {
				await dispose();
			}
		});
	});

	describe("happy path", () => {
		it("executes all steps without calling undo", async () => {
			const { testId, dispose } = await runWorkflow({ scenario: "happy-path" });

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				expect(runLogs).toHaveLength(3);
				expect(undoLogs).toHaveLength(0);
				expect(runLogs.map((l) => l.stepName)).toEqual([
					"step-1",
					"step-2",
					"step-3",
				]);
			} finally {
				await dispose();
			}
		});
	});

	describe("rollback on failure", () => {
		it("calls undo in LIFO order when step fails", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "rollback-on-failure",
				failAtStep: 3,
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				// Steps 1, 2 ran successfully (logged), step 3 failed (not logged)
				expect(runLogs).toHaveLength(2);
				expect(runLogs.map((l) => l.stepName)).toEqual(["step-1", "step-2"]);

				// Only steps 1 and 2 should be undone (LIFO order: 2, then 1)
				expect(undoLogs).toHaveLength(2);
				expect(undoLogs.map((l) => l.stepName)).toEqual(["step-2", "step-1"]);
			} finally {
				await dispose();
			}
		});

		it("passes error to each undo handler", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "rollback-on-failure",
				failAtStep: 2,
			});

			try {
				const logs = await getCallLogs(testId);
				const undoLogs = logs.filter((l) => l.type === "undo");

				expect(undoLogs).toHaveLength(1);
				expect(undoLogs[0]?.data.error).toContain(
					"Intentional failure at step 2",
				);
			} finally {
				await dispose();
			}
		});

		it("passes correct value to each undo handler", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "rollback-on-failure",
				failAtStep: 3,
			});

			try {
				const logs = await getCallLogs(testId);
				const undoLogs = logs.filter((l) => l.type === "undo");

				// step-2 undo receives "result-2", step-1 undo receives "result-1"
				const step2Undo = undoLogs.find((l) => l.stepName === "step-2");
				const step1Undo = undoLogs.find((l) => l.stepName === "step-1");

				expect(step2Undo?.data.value).toBe("result-2");
				expect(step1Undo?.data.value).toBe("result-1");
			} finally {
				await dispose();
			}
		});
	});

	describe("passthrough do method", () => {
		it("executes regular do steps without affecting undo stack", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "mixed-steps",
				failAtStep: 4,
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				// First 3 steps executed successfully (logged), 4th failed (not logged)
				expect(runLogs.map((l) => l.stepName)).toEqual([
					"regular-step-1",
					"rollback-step-1",
					"regular-step-2",
				]);

				// Only rollback steps should have undo called
				// rollback-step-2 failed, so only rollback-step-1 is undone
				expect(undoLogs).toHaveLength(1);
				expect(undoLogs[0]?.stepName).toBe("rollback-step-1");
			} finally {
				await dispose();
			}
		});
	});

	describe("edge cases", () => {
		it("handles empty rollback stack gracefully", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "empty-rollback",
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				expect(runLogs.map((l) => l.stepName)).toEqual([
					"before-rollback",
					"after-rollback",
				]);
				expect(undoLogs).toHaveLength(0);
			} finally {
				await dispose();
			}
		});
	});

	describe("config passthrough", () => {
		it("accepts WorkflowStepConfig parameter", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "config-passthrough",
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");

				expect(runLogs).toHaveLength(1);
				expect(runLogs[0]?.stepName).toBe("config-step");
			} finally {
				await dispose();
			}
		});
	});

	describe("workflow replay after sleep", () => {
		it("rebuilds undo stack correctly after hibernate/replay", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "replay-after-sleep",
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				// Steps A, B completed before sleep, then after-sleep, then C
				// Step D failed (not logged)
				expect(runLogs.map((l) => l.stepName)).toEqual([
					"step-a",
					"step-b",
					"after-sleep",
					"step-c",
				]);

				// ALL steps should be undone in LIFO order: C, B, A
				// This verifies the undo stack rebuilt correctly after replay
				expect(undoLogs).toHaveLength(3);
				expect(undoLogs.map((l) => l.stepName)).toEqual([
					"step-c",
					"step-b",
					"step-a",
				]);

				// Verify correct values passed to each undo
				expect(undoLogs[0]?.data.value).toBe("result-c");
				expect(undoLogs[1]?.data.value).toBe("result-b");
				expect(undoLogs[2]?.data.value).toBe("result-a");
			} finally {
				await dispose();
			}
		});
	});

	describe("undo handler throws", () => {
		it("throws NonRetryableError when undo fails, stopping further undos", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "undo-throws",
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				// Steps 1, 2 ran successfully
				expect(runLogs.filter((l) => l.stepName.startsWith("step"))).toHaveLength(
					2,
				);

				// Undo for step-2 was attempted (logged before throw)
				expect(undoLogs.some((l) => l.stepName === "step-2-before-throw")).toBe(
					true,
				);

				// step-1 undo should NOT have been called because rollbackAll threw
				// NonRetryableError after step-2's undo failed
				expect(undoLogs.some((l) => l.stepName === "step-1")).toBe(false);

				// Workflow should have errored (after-rollback log not present)
				expect(runLogs.some((l) => l.stepName === "after-rollback")).toBe(false);
			} finally {
				await dispose();
			}
		});
	});

	describe("null/undefined return values", () => {
		it("correctly passes null and undefined to undo handlers", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "run-returns-null",
			});

			try {
				const logs = await getCallLogs(testId);
				const undoLogs = logs.filter((l) => l.type === "undo");

				// Both null-step and undefined-step should be undone
				expect(undoLogs).toHaveLength(2);

				const nullUndo = undoLogs.find((l) => l.stepName === "null-step");
				const undefinedUndo = undoLogs.find(
					(l) => l.stepName === "undefined-step",
				);

				expect(nullUndo?.data.valueIsNull).toBe(true);
				expect(undefinedUndo?.data.valueIsUndefined).toBe(true);
			} finally {
				await dispose();
			}
		});
	});

	describe("multiple rollbackAll calls", () => {
		it("is idempotent - second call is no-op", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "multiple-rollback-calls",
			});

			try {
				const logs = await getCallLogs(testId);
				const runLogs = logs.filter((l) => l.type === "run");
				const undoLogs = logs.filter((l) => l.type === "undo");

				// All three rollback calls completed
				expect(runLogs.map((l) => l.stepName)).toEqual([
					"step-1",
					"after-first-rollback",
					"after-second-rollback",
					"after-third-rollback",
				]);

				// Undo only called ONCE (on first rollbackAll)
				expect(undoLogs).toHaveLength(1);
				expect(undoLogs[0]?.stepName).toBe("step-1");
			} finally {
				await dispose();
			}
		});
	});

	describe("non-Error error types", () => {
		it("handles string errors correctly", async () => {
			const { testId, dispose } = await runWorkflow({
				scenario: "string-error",
			});

			try {
				const logs = await getCallLogs(testId);
				const undoLogs = logs.filter((l) => l.type === "undo");

				expect(undoLogs).toHaveLength(1);
				// NOTE: Cloudflare Workflows wraps thrown non-Error values in Error objects
				// The string "String error..." becomes Error("String error...")
				expect(undoLogs[0]?.data.errorType).toBe("object");
				expect(undoLogs[0]?.data.error).toContain(
					"String error instead of Error object",
				);
			} finally {
				await dispose();
			}
		});
	});
});
