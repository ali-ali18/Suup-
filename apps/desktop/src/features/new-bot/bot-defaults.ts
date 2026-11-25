import type { Bot, ModelInfo, ToolInfo } from "@suup/api";
import { useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { friendlyError } from "../../lib/friendly-error.js";

/** What a bot runs on and may use: the model and the tools, with the defaults a new bot gets. */
export interface BotDefaults {
  models: ModelInfo[];
  toolInfo: ToolInfo[];
  modelId: string;
  setModelId(id: string): void;
  tools: string[] | undefined;
  setTools(tools: string[]): void;
}

/**
 * Loads the models and the tools and picks what a bot starts with: the model and the tools of
 * `editing`; else those of the team's main bot (the supervisor) when there is one; else, with no
 * main bot at all (the first one of the team), the first model that is available and every tool.
 */
export function useBotDefaults(editing: Bot | undefined, main: Bot | undefined): BotDefaults {
  const { api } = useServices();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [toolInfo, setToolInfo] = useState<ToolInfo[]>([]);
  const [modelId, setModelId] = useState(editing?.modelId ?? "");
  const [tools, setTools] = useState<string[] | undefined>(editing?.allowedTools);

  useEffect(() => {
    let current = true;
    void Promise.all([api.models.list(), api.tools.list()]).then(
      ([m, t]) => {
        if (!current) return;
        setModels(m);
        setToolInfo(t.items);
        setModelId(
          (id) =>
            id ||
            (main !== undefined && m.some((x) => x.id === main.modelId && x.available)
              ? main.modelId
              : (m.find((x) => x.available)?.id ?? m[0]?.id ?? "")),
        );
        setTools((cur) => cur ?? main?.allowedTools ?? t.items.map((x) => x.name));
      },
      (e: unknown) => useUi.getState().toast(friendlyError(e), "error"),
    );
    return () => {
      current = false;
    };
  }, [api]);

  return { models, toolInfo, modelId, setModelId, tools, setTools };
}
