import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { withRollback } from "../../src/index.ts";

export type TestScenario =
	| "happy-path"
	| "rollback-on-failure"
	| "mixed-steps"
	| "empty-rollback"
	| "config-passthrough"
	| "basic-step"
	| "ctx-do-passthrough"
	| "replay-after-sleep"
	| "undo-throws"
	| "run-returns-null"
	| "multiple-rollback-calls"
	| "string-error";

export type TestParams = {
	scenario: TestScenario;
	failAtStep?: number;
	testId: string;
};

export type TestEnv = {
	CALL_LOG: KVNamespace;
};

export class TestWorkflow extends WorkflowEntrypoint<TestEnv, TestParams> {
	private callCounter = 0;

	private async log(
		testId: string,
		type: "run" | "undo",
		stepName: string,
		data: Record<string, unknown> = {},
	): Promise<void> {
		const key = `${testId}:${String(this.callCounter++).padStart(5, "0")}:${type}:${stepName}`;
		await this.env.CALL_LOG.put(
			key,
			JSON.stringify({ ...data, timestamp: Date.now() }),
		);
	}

	override async run(
		event: WorkflowEvent<TestParams>,
		step: WorkflowStep,
	): Promise<unknown> {
		const { scenario, failAtStep, testId } = event.payload;
		this.callCounter = 0;

		switch (scenario) {
			case "basic-step":
				return this.basicStep(step, testId);
			case "ctx-do-passthrough":
				return this.ctxDoPassthrough(step, testId);
			case "happy-path":
				return this.happyPath(step, testId);
			case "rollback-on-failure":
				return this.rollbackOnFailure(step, testId, failAtStep ?? 3);
			case "mixed-steps":
				return this.mixedSteps(step, testId, failAtStep ?? 4);
			case "empty-rollback":
				return this.emptyRollback(step, testId);
			case "config-passthrough":
				return this.configPassthrough(step, testId);
			case "replay-after-sleep":
				return this.replayAfterSleep(step, testId);
			case "undo-throws":
				return this.undoThrows(step, testId);
			case "run-returns-null":
				return this.runReturnsNull(step, testId);
			case "multiple-rollback-calls":
				return this.multipleRollbackCalls(step, testId);
			case "string-error":
				return this.stringError(step, testId);
			default:
				throw new Error(`Unknown scenario: ${scenario}`);
		}
	}

	// Test if withRollback's ctx.do passthrough works
	private async ctxDoPassthrough(
		step: WorkflowStep,
		testId: string,
	): Promise<{ result: string }> {
		const ctx = withRollback(step);
		// Use ctx.do which is workflowStep.do.bind(workflowStep)
		const result = await ctx.do("ctx-do-test", async () => "ctx-do-result");
		await this.log(testId, "run", "ctx-do-test", { result });
		return { result };
	}

	// Basic test: verify step.do works at all
	private async basicStep(
		step: WorkflowStep,
		testId: string,
	): Promise<{ result: string }> {
		// Test 2-arg form
		const result = await step.do("basic", async () => "basic-result");
		await this.log(testId, "run", "basic", { result });

		// Test 3-arg form with empty config (this is how withRollback calls it)
		const result2 = await step.do("basic-with-config", {}, async () => "basic-config-result");
		await this.log(testId, "run", "basic-with-config", { result: result2 });

		return { result };
	}

	private async happyPath(
		step: WorkflowStep,
		testId: string,
	): Promise<{ results: string[] }> {
		const ctx = withRollback(step);
		const results: string[] = [];

		const r1 = await ctx.doWithRollback("step-1", {
			run: async () => "result-1",
			undo: async (err, value) => {
				await this.log(testId, "undo", "step-1", {
					error: String(err),
					value,
				});
			},
		});
		await this.log(testId, "run", "step-1");
		results.push(r1);

		const r2 = await ctx.doWithRollback("step-2", {
			run: async () => "result-2",
			undo: async (err, value) => {
				await this.log(testId, "undo", "step-2", {
					error: String(err),
					value,
				});
			},
		});
		await this.log(testId, "run", "step-2");
		results.push(r2);

		const r3 = await ctx.doWithRollback("step-3", {
			run: async () => "result-3",
			undo: async (err, value) => {
				await this.log(testId, "undo", "step-3", {
					error: String(err),
					value,
				});
			},
		});
		await this.log(testId, "run", "step-3");
		results.push(r3);

		return { results };
	}

	private async rollbackOnFailure(
		step: WorkflowStep,
		testId: string,
		failAt: number,
	): Promise<{ rolledBack: boolean }> {
		const ctx = withRollback(step);

		try {
			for (let i = 1; i <= 3; i++) {
				const stepName = `step-${i}`;
				await ctx.doWithRollback(
					stepName,
					{
						run: async () => {
							if (i === failAt) {
								throw new Error(`Intentional failure at step ${i}`);
							}
							return `result-${i}`;
						},
						undo: async (err, value) => {
							await this.log(testId, "undo", stepName, {
								error: String(err),
								value,
							});
						},
					},
					// Disable retries so intentional failures don't retry
					{ retries: { limit: 0 } },
				);
				await this.log(testId, "run", stepName);
			}
			return { rolledBack: false };
		} catch (error) {
			await ctx.rollbackAll(error);
			return { rolledBack: true };
		}
	}

	private async mixedSteps(
		step: WorkflowStep,
		testId: string,
		failAt: number,
	): Promise<{ rolledBack: boolean }> {
		const ctx = withRollback(step);

		try {
			await ctx.do("regular-step-1", async () => "regular-1");
			await this.log(testId, "run", "regular-step-1");

			await ctx.doWithRollback("rollback-step-1", {
				run: async () => "rollback-1",
				undo: async (err, value) => {
					await this.log(testId, "undo", "rollback-step-1", {
						error: String(err),
						value,
					});
				},
			});
			await this.log(testId, "run", "rollback-step-1");

			await ctx.do("regular-step-2", async () => "regular-2");
			await this.log(testId, "run", "regular-step-2");

			await ctx.doWithRollback(
				"rollback-step-2",
				{
					run: async () => {
						if (failAt === 4) {
							throw new Error("Intentional failure");
						}
						return "rollback-2";
					},
					undo: async (err, value) => {
						await this.log(testId, "undo", "rollback-step-2", {
							error: String(err),
							value,
						});
					},
				},
				// Disable retries so intentional failures don't retry
				{ retries: { limit: 0 } },
			);
			await this.log(testId, "run", "rollback-step-2");

			return { rolledBack: false };
		} catch (error) {
			await ctx.rollbackAll(error);
			return { rolledBack: true };
		}
	}

	private async emptyRollback(
		step: WorkflowStep,
		testId: string,
	): Promise<{ success: boolean }> {
		const ctx = withRollback(step);
		await this.log(testId, "run", "before-rollback");
		await ctx.rollbackAll(new Error("Test error"));
		await this.log(testId, "run", "after-rollback");
		return { success: true };
	}

	private async configPassthrough(
		step: WorkflowStep,
		testId: string,
	): Promise<{ result: string }> {
		const ctx = withRollback(step);

		const result = await ctx.doWithRollback(
			"config-step",
			{
				run: async () => "config-result",
				undo: async (err, value) => {
					await this.log(testId, "undo", "config-step", {
						error: String(err),
						value,
					});
				},
			},
			{
				retries: { limit: 2, delay: "1 second", backoff: "linear" },
				timeout: "30 seconds",
			},
		);
		await this.log(testId, "run", "config-step");

		return { result };
	}

	// Test that undo stack rebuilds correctly after workflow replay (sleep)
	private async replayAfterSleep(
		step: WorkflowStep,
		testId: string,
	): Promise<{ rolledBack: boolean }> {
		const ctx = withRollback(step);

		try {
			// Step A - before sleep
			await ctx.doWithRollback("step-a", {
				run: async () => "result-a",
				undo: async (err, value) => {
					await this.log(testId, "undo", "step-a", {
						error: String(err),
						value,
					});
				},
			});
			await this.log(testId, "run", "step-a");

			// Step B - before sleep
			await ctx.doWithRollback("step-b", {
				run: async () => "result-b",
				undo: async (err, value) => {
					await this.log(testId, "undo", "step-b", {
						error: String(err),
						value,
					});
				},
			});
			await this.log(testId, "run", "step-b");

			// Sleep triggers hibernate + replay
			await step.sleep("test-sleep", "1 second");
			await this.log(testId, "run", "after-sleep");

			// Step C - after sleep
			await ctx.doWithRollback("step-c", {
				run: async () => "result-c",
				undo: async (err, value) => {
					await this.log(testId, "undo", "step-c", {
						error: String(err),
						value,
					});
				},
			});
			await this.log(testId, "run", "step-c");

			// Step D - fails
			await ctx.doWithRollback(
				"step-d",
				{
					run: async () => {
						throw new Error("Intentional failure after sleep");
					},
					undo: async () => {
						// Won't be called since step-d failed
					},
				},
				{ retries: { limit: 0 } },
			);

			return { rolledBack: false };
		} catch (error) {
			await ctx.rollbackAll(error);
			return { rolledBack: true };
		}
	}

	// Test behavior when an undo handler throws
	private async undoThrows(
		step: WorkflowStep,
		testId: string,
	): Promise<{ undoError: boolean }> {
		const ctx = withRollback(step);

		try {
			// undoConfig inherits from outer config (retries: 0)
			await ctx.doWithRollback(
				"step-1",
				{
					run: async () => "result-1",
					undo: async (err, value) => {
						await this.log(testId, "undo", "step-1", {
							error: String(err),
							value,
						});
					},
				},
				{ retries: { limit: 0 } },
			);
			await this.log(testId, "run", "step-1");

			// undoConfig inherits retries: 0, so undo fails immediately
			await ctx.doWithRollback(
				"step-2",
				{
					run: async () => "result-2",
					// This undo will throw
					undo: async () => {
						await this.log(testId, "undo", "step-2-before-throw");
						throw new Error("Undo failed!");
					},
				},
				{ retries: { limit: 0 } },
			);
			await this.log(testId, "run", "step-2");

			await ctx.doWithRollback(
				"step-3",
				{
					run: async () => {
						throw new Error("Trigger rollback");
					},
					undo: async () => {},
				},
				{ retries: { limit: 0 } },
			);

			return { undoError: false };
		} catch (error) {
			// rollbackAll will throw NonRetryableError when step-2's undo fails
			// This propagates up and errors the workflow
			await ctx.rollbackAll(error);
			await this.log(testId, "run", "after-rollback");
			return { undoError: false };
		}
	}

	// Test that null/undefined return values work
	private async runReturnsNull(
		step: WorkflowStep,
		testId: string,
	): Promise<{ rolledBack: boolean }> {
		const ctx = withRollback(step);

		try {
			await ctx.doWithRollback("null-step", {
				run: async () => null,
				undo: async (err, value) => {
					await this.log(testId, "undo", "null-step", {
						error: String(err),
						value,
						valueIsNull: value === null,
					});
				},
			});
			await this.log(testId, "run", "null-step");

			await ctx.doWithRollback("undefined-step", {
				run: async () => undefined,
				undo: async (err, value) => {
					await this.log(testId, "undo", "undefined-step", {
						error: String(err),
						value,
						valueIsUndefined: value === undefined,
					});
				},
			});
			await this.log(testId, "run", "undefined-step");

			await ctx.doWithRollback(
				"fail-step",
				{
					run: async () => {
						throw new Error("Trigger rollback");
					},
					undo: async () => {},
				},
				{ retries: { limit: 0 } },
			);

			return { rolledBack: false };
		} catch (error) {
			await ctx.rollbackAll(error);
			return { rolledBack: true };
		}
	}

	// Test that calling rollbackAll multiple times is safe (idempotent)
	private async multipleRollbackCalls(
		step: WorkflowStep,
		testId: string,
	): Promise<{ success: boolean }> {
		const ctx = withRollback(step);

		await ctx.doWithRollback("step-1", {
			run: async () => "result-1",
			undo: async (err, value) => {
				await this.log(testId, "undo", "step-1", {
					error: String(err),
					value,
				});
			},
		});
		await this.log(testId, "run", "step-1");

		// First rollback
		await ctx.rollbackAll(new Error("First rollback"));
		await this.log(testId, "run", "after-first-rollback");

		// Second rollback - should be no-op
		await ctx.rollbackAll(new Error("Second rollback"));
		await this.log(testId, "run", "after-second-rollback");

		// Third rollback - should be no-op
		await ctx.rollbackAll(new Error("Third rollback"));
		await this.log(testId, "run", "after-third-rollback");

		return { success: true };
	}

	// Test with non-Error error type (string)
	private async stringError(
		step: WorkflowStep,
		testId: string,
	): Promise<{ rolledBack: boolean }> {
		const ctx = withRollback(step);

		try {
			await ctx.doWithRollback("step-1", {
				run: async () => "result-1",
				undo: async (err, value) => {
					await this.log(testId, "undo", "step-1", {
						error: String(err),
						errorType: typeof err,
						value,
					});
				},
			});
			await this.log(testId, "run", "step-1");

			await ctx.doWithRollback(
				"step-2",
				{
					run: async () => {
						throw "String error instead of Error object";
					},
					undo: async () => {},
				},
				{ retries: { limit: 0 } },
			);

			return { rolledBack: false };
		} catch (error) {
			await ctx.rollbackAll(error);
			return { rolledBack: true };
		}
	}
}

export default {
	async fetch(): Promise<Response> {
		return new Response("Test worker");
	},
};
