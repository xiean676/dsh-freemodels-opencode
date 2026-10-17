//#region src/index.d.ts
declare const name = "dsh-freemodels-opencode";
/** Hard dependency: the provider cannot be registered without the LLM runtime. */
declare const inject: string[];
interface PluginConfig {
  /** Override the Zen gateway (tests); defaults to the public one. */
  baseUrl?: string;
}
declare function apply(ctx: unknown, config?: PluginConfig): void;
//#endregion
export { PluginConfig, apply, inject, name };