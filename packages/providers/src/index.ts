import type { Provider } from "@suup/core";
import { type AnthropicProviderConfig, createAnthropicProvider } from "./anthropic.js";
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from "./openai-compatible.js";

export { type AnthropicProviderConfig, createAnthropicProvider } from "./anthropic.js";
export {
  createOpenAICompatibleProvider,
  type OpenAICompatibleProviderConfig,
} from "./openai-compatible.js";
export type { Sleep } from "./retry.js";
export type { BaseProviderConfig, ExchangeInfo } from "./transport.js";

export type ProviderConfig =
  | ({ kind: "anthropic" } & AnthropicProviderConfig)
  | ({ kind: "openai-compatible" } & OpenAICompatibleProviderConfig);

/** Builds a provider from a config tagged with its `kind`. */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "anthropic": {
      const { kind: _kind, ...rest } = config;
      return createAnthropicProvider(rest);
    }
    case "openai-compatible": {
      const { kind: _kind, ...rest } = config;
      return createOpenAICompatibleProvider(rest);
    }
    default:
      throw new Error(`Unknown provider kind: ${String((config as { kind?: unknown }).kind)}`);
  }
}
