import { describe, expect, it } from "vitest";
import * as api from "../src/index.ts";

// The programmatic example in packages/opencontact/README.md uses these exports.
describe("README example", () => {
  it("exports what the example imports", () => {
    for (const name of [
      "Bridge",
      "ImsgRpc",
      "spawnImsg",
      "FileStateStore",
      "JsonlAudit",
      "createBrain",
      "createLogger",
      "configSecrets",
      "loadConfig",
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
