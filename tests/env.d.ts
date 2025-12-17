import type { TestWorkflow } from "./helpers/test-workflow";

interface Env {
	CALL_LOG: KVNamespace;
	TEST_WORKFLOW: Workflow<TestWorkflow>;
}

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}
