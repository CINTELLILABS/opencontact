import { join } from "node:path";
import type { AuditSink } from "./audit.ts";
import { BlandClient } from "./bland.ts";
import { BlandBrain, type Brain, CommandBrain, FileTranscriptStore, LlmBrain, loadPersona } from "./brain.ts";
import type { BridgeConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { StateStore } from "./state.ts";

/** Build the configured brain. */
export function createBrain(
  config: BridgeConfig,
  deps: { state: StateStore; audit: AuditSink; log: Logger; userAgent: string },
): Brain {
  const b = config.brain;
  switch (b.kind) {
    case "bland":
      return new BlandBrain(
        new BlandClient({ apiUrl: config.apiUrl, apiKey: config.apiKey, userAgent: deps.userAgent }),
        config,
        deps.state,
        deps.audit,
        deps.log,
      );
    case "anthropic":
      return new LlmBrain({
        kind: "anthropic",
        apiKey: b.apiKey,
        model: b.model,
        effort: b.effort,
        persona: loadPersona(b.personaPath, b.personaName),
        transcripts: new FileTranscriptStore(join(config.stateDir, "transcripts")),
      });
    case "openai":
      return new LlmBrain({
        kind: "openai",
        apiKey: b.apiKey,
        model: b.model,
        baseUrl: b.baseUrl,
        persona: loadPersona(b.personaPath, b.personaName),
        transcripts: new FileTranscriptStore(join(config.stateDir, "transcripts")),
      });
    case "command":
      return new CommandBrain({
        command: b.command,
        persona: loadPersona(b.personaPath, b.personaName),
        transcripts: new FileTranscriptStore(join(config.stateDir, "transcripts")),
      });
  }
}
