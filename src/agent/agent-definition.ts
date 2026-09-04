/** Provider-neutral model selection owned by an agent definition. */
export interface AgentModelConfiguration {
  /** Resolved by the configured Sampler; it does not select a provider directly. */
  readonly modelId: string;
}

/** Immutable configuration describing an agent without owning its execution. */
export interface AgentDefinition {
  readonly name: string;
  readonly systemPrompt: string;
  readonly model: AgentModelConfiguration;
}
