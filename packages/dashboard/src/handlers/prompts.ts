import { readFileSync } from "fs";
import type { SkynetConfig, PromptTemplate } from "../types";

/**
 * List of worker/agent scripts that have associated prompt files.
 * IMPORTANT: Update this list when adding new worker types to scripts/.
 */
const PROMPT_SCRIPTS = [
  "dev-worker",
  "task-fixer",
  "project-driver",
  "health-check",
  "ui-tester",
  "feature-validator",
];

/**
 * Extract the PROMPT="..." block from a bash script.
 * Scans from the opening PROMPT=" to the first unescaped closing ".
 */
function extractPrompt(scriptContent: string): string | null {
  const marker = 'PROMPT="';
  const startIdx = scriptContent.indexOf(marker);
  if (startIdx === -1) return null;

  const contentStart = startIdx + marker.length;
  for (let i = contentStart; i < scriptContent.length; i++) {
    if (scriptContent[i] === '"' && scriptContent[i - 1] !== "\\") {
      return scriptContent.slice(contentStart, i);
    }
  }
  return null;
}

export function createPromptsHandler(config: SkynetConfig) {
  const scriptsDir = config.scriptsDir ?? `${config.devDir}/scripts`;

  return async function GET(): Promise<Response> {
    try {
      const prompts: PromptTemplate[] = [];

      for (const scriptName of PROMPT_SCRIPTS) {
        // scriptName is from hardcoded PROMPT_SCRIPTS array — not user input. Path traversal not applicable.
        const filePath = `${scriptsDir}/${scriptName}.sh`;
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }

        const prompt = extractPrompt(content);
        if (!prompt) continue;

        const worker = config.workers.find(
          (w) => w.name === scriptName || w.name.startsWith(scriptName + "-")
        );

        prompts.push({
          scriptName,
          workerLabel:
            worker?.label ??
            scriptName
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase()),
          description: worker?.description ?? "",
          category: worker?.category ?? "core",
          prompt,
        });
      }

      return Response.json({ data: prompts, error: null });
    } catch (err) {
      return Response.json(
        {
          data: null,
          error: process.env.NODE_ENV === "development"
            ? (err instanceof Error ? err.message : "Failed to read prompts")
            : "Internal server error",
        },
        { status: 500 }
      );
    }
  };
}
