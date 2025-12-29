import {
	NonRetryableError,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workflows";

type Serializable<T> = Rpc.Serializable<T>;

/**
 * Handler for a step that can be undone.
 * @template T - The return type of the step
 */
export type RollbackHandler<T> = Readonly<{
	/** The step function to execute */
	run: () => Promise<T>;
	/** The undo function to call if a later step fails */
	undo: (err: unknown, value: T) => Promise<void>;
}>;

/**
 * Extended config for doWithRollback that includes undo step configuration.
 */
export type RollbackStepConfig = WorkflowStepConfig & {
	/** Config for the undo step. "inherit" (default) uses the run step's config. */
	undo?: "inherit" | WorkflowStepConfig;
};

/**
 * The return type of withRollback
 */
export type RollbackContext = {
	/** The original step.do method */
	do: WorkflowStep["do"];
	/** Execute a step with a rollback handler */
	doWithRollback: <T extends Serializable<T>>(
		name: string,
		handler: RollbackHandler<T>,
		config?: RollbackStepConfig,
	) => Promise<T>;
	/** Execute all registered undo handlers in LIFO order */
	rollbackAll: (error: unknown) => Promise<void>;
};

/**
 * Wraps a Cloudflare Workflow step with rollback capabilities.
 *
 * Returns an object with:
 * - `do` - The original step.do method
 * - `doWithRollback` - Execute a step with an undo handler
 * - `rollbackAll` - Execute all registered undo handlers in LIFO order
 *
 * @example
 * ```ts
 * const step = withRollback(workflowStep);
 *
 * try {
 *   // Regular step (no rollback)
 *   const data = await step.do("fetch data", async () => fetchData());
 *
 *   // Step with rollback
 *   const id = await step.doWithRollback("save to db", {
 *     run: async () => db.insert(data),
 *     undo: async (_, id) => db.delete(id),
 *   });
 *
 *   await step.do("notify", async () => sendNotification());
 * } catch (error) {
 *   await step.rollbackAll(error);
 *   throw error;
 * }
 * ```
 */
export function withRollback(workflowStep: WorkflowStep): RollbackContext {
	const undoStack: {
		name: string;
		execute: (error: unknown) => Promise<void>;
	}[] = [];

	/**
	 * Execute a step with a rollback handler.
	 * The undo function will be called if a later step fails.
	 */
	async function doWithRollback<T extends Serializable<T>>(
		name: string,
		handler: RollbackHandler<T>,
		config: RollbackStepConfig = {},
	): Promise<T> {
		const { undo: undoConfigOption, ...runConfig } = config;
		const result = (await workflowStep.do(name, runConfig, handler.run)) as T;

		const undoConfig =
			undoConfigOption === undefined || undoConfigOption === "inherit"
				? runConfig
				: undoConfigOption;

		undoStack.push({
			name,
			execute: (error: unknown) =>
				workflowStep.do(`Undo '${name}'`, undoConfig, async () =>
					handler.undo(error, result),
				),
		});

		return result;
	}

	/**
	 * Execute all registered undo handlers in LIFO order.
	 * Call this in your catch block to rollback completed steps.
	 * @throws {NonRetryableError} If an undo handler fails after exhausting retries
	 */
	async function rollbackAll(error: unknown): Promise<void> {
		while (undoStack.length > 0) {
			const undo = undoStack.pop();
			if (!undo) continue;

			try {
				await undo.execute(error);
			} catch (undoError) {
				throw new NonRetryableError(
					`Undo failed for step '${undo.name}': ${undoError instanceof Error ? undoError.message : String(undoError)}`,
					{ cause: { originalError: error, undoError, stepName: undo.name } },
				);
			}
		}
	}

	return {
		/** The original step.do method (wrapped to avoid RPC bind issues) */
		do: ((name, configOrFn, fn?) =>
			workflowStep.do(name, configOrFn, fn)) as WorkflowStep["do"],
		/** Execute a step with a rollback handler */
		doWithRollback: doWithRollback,
		/** Execute all registered undo handlers in LIFO order */
		rollbackAll: rollbackAll,
	};
}
