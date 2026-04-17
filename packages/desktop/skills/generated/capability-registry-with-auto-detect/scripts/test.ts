interface CapabilityEntry {
  id: string;
  version: string;
  features: string[];
  load: () => Promise<unknown>;
  constraints?: { minMemory?: number; envVars?: string[] };
}

const CAPABILITY_REGISTRY: Record<string, CapabilityEntry> = {
  "llm-fast": { id: "llm-fast", version: "1.0", features: ["completion"], load: () => import("./fast-provider") },
  "llm-accurate": { id: "llm-accurate", version: "2.0", features: ["completion", "reasoning"], load: () => import("./accurate-provider") }
};