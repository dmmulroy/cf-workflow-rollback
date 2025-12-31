import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";

// Custom Serializable that filters out symbol keys (upstream Rpc.Serializable maps them to never, breaking types)
type Serializable<T> = T extends
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | ReadableStream
  | Blob
  ? T
  : T extends Array<infer U>
    ? Array<Serializable<U>>
    : T extends Map<infer K, infer V>
      ? Map<Serializable<K>, Serializable<V>>
      : T extends Set<infer V>
        ? Set<Serializable<V>>
        : T extends object
          ? { [K in keyof T as K extends string | number ? K : never]: Serializable<T[K]> }
          : never;

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
  doWithRollback: <T>(
    name: string,
    handler: RollbackHandler<T>,
    config?: RollbackStepConfig,
  ) => Promise<Serializable<T>>;
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
  async function doWithRollback<T>(
    name: string,
    handler: RollbackHandler<T>,
    config: RollbackStepConfig = {},
  ): Promise<Serializable<T>> {
    const { undo: undoConfigOption, ...runConfig } = config;
    // Cast: CF types use Rpc.Serializable which chokes on symbols; we use our own that strips them
    const result = (await workflowStep.do(
      name,
      runConfig,
      handler.run as () => Promise<Rpc.Serializable<T>>,
    )) as Serializable<T>;

    const undoConfig =
      undoConfigOption === undefined || undoConfigOption === "inherit"
        ? runConfig
        : undoConfigOption;

    undoStack.push({
      name,
      execute: (error: unknown) =>
        workflowStep.do(`Undo '${name}'`, undoConfig, async () =>
          handler.undo(error, result as T),
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
        const err = new NonRetryableError(
          `Undo failed for step '${undo.name}': ${undoError instanceof Error ? undoError.message : String(undoError)}`,
        );
        err.cause = { originalError: error, undoError, stepName: undo.name };
        throw err;
      }
    }
  }

  return {
    /** The original step.do method (wrapped to avoid RPC bind issues) */
    do: (<T>(
      name: string,
      configOrFn: WorkflowStepConfig | (() => Promise<T>),
      fn?: () => Promise<T>,
    ): Promise<Serializable<T>> =>
      (fn
        ? workflowStep.do(
            name,
            configOrFn as WorkflowStepConfig,
            fn as () => Promise<Rpc.Serializable<T>>,
          )
        : workflowStep.do(
            name,
            configOrFn as () => Promise<Rpc.Serializable<T>>,
          )
      ) as Promise<Serializable<T>>) as WorkflowStep["do"],
    /** Execute a step with a rollback handler */
    doWithRollback: doWithRollback,
    /** Execute all registered undo handlers in LIFO order */
    rollbackAll: rollbackAll,
  };
}
