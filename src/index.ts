// Useful Work agent kit: answer a tool's 402 with useful work instead of a payment.

export { readWorkExtension, wrapFetchWithWork, type Solver, type WorkEvent, type WorkFetchOptions } from "./client.js";
export { llmSolver, toAnswer, toFixAnswer, type LlmOptions, type ModelUsage } from "./llm-solver.js";
export { anthropicSolver, toAnthropicModel, type AnthropicOptions } from "./anthropic-solver.js";
export { linkSolver } from "./link-solver.js";
export { checkAddress, type Observation } from "./link-check.js";
export { FetchBlockedError, isPrivateAddress, safeFetch } from "./safe-fetch.js";
export * from "./protocol.js";
export { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./options.js";
