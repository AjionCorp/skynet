import { spawn } from "child_process";
import type { SkynetConfig, MissionCreatorResult } from "../types";
import { parseBody } from "../lib/parse-body";
import { logHandlerError } from "../lib/handler-error";

const DEFAULT_GENERATE_TIMEOUT_MS = 300_000;
const DEFAULT_EXPAND_TIMEOUT_MS = 180_000;
const TIMEOUT_ERROR_MESSAGE = "AI generation timed out";

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 5_000) return 5_000;
  if (parsed > 900_000) return 900_000;
  return parsed;
}

function extractJson<T>(raw: string): T {
  const trimmed = raw.trim();

  // 1. Try direct parse
  try {
    const parsed = JSON.parse(trimmed);
    // If Claude CLI wrapped output in a metadata envelope, unwrap .result
    if (parsed && typeof parsed.result === "string") {
      return extractJson<T>(parsed.result);
    }
    return parsed as T;
  } catch {
    // continue to fallback strategies
  }

  // 2. Try extracting from ```json ... ``` code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  // 3. Try finding first { ... } or [ ... ] block in the text
  const braceMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[1]) as T;
    } catch {
      // continue
    }
  }

  throw new Error("Failed to parse JSON from AI response");
}

function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Remove CLAUDECODE env var to allow spawning Claude CLI from within a Claude Code session
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn("claude", ["--print"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGTERM");
        reject(new Error(TIMEOUT_ERROR_MESSAGE));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString().trim();
        reject(new Error(stderr || `Claude CLI exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString());
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function createMissionCreatorHandler(_config: SkynetConfig) {
  async function POST(request: Request): Promise<Response> {
    try {
      const generateTimeoutMs = timeoutMsFromEnv("SKYNET_MISSION_CREATOR_TIMEOUT_MS", DEFAULT_GENERATE_TIMEOUT_MS);
      const { data: body, error: parseError, status: parseStatus } = await parseBody<{
        input?: string;
        currentMission?: string;
      }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }

      const { input, currentMission } = body;
      if (!input || typeof input !== "string" || !input.trim()) {
        return Response.json({ data: null, error: "Missing 'input' field (string)" }, { status: 400 });
      }
      if (input.length > 10_000) {
        return Response.json({ data: null, error: "Input must be 10,000 characters or fewer" }, { status: 400 });
      }
      if (currentMission !== undefined && typeof currentMission !== "string") {
        return Response.json({ data: null, error: "'currentMission' must be a string" }, { status: 400 });
      }
      if (typeof currentMission === "string" && currentMission.length > 100_000) {
        return Response.json({ data: null, error: "currentMission must be 100,000 characters or fewer" }, { status: 400 });
      }

      const missionContext = currentMission
        ? `\n\nCurrent mission document for reference:\n${currentMission}`
        : "";

      const prompt = `You are a mission architect for an autonomous AI development pipeline. Given the user's description, create a structured mission document in markdown and exactly 3 improvement suggestions.

User wants: ${input}${missionContext}

You MUST respond with valid JSON matching this exact shape:
{
  "mission": "# Mission\\n\\n## Purpose\\n...\\n\\n## Goals\\n- [ ] Goal 1\\n- [ ] Goal 2\\n...\\n\\n## Success Criteria\\n- [ ] Criterion 1\\n- [ ] Criterion 2\\n...\\n\\n## Current Focus\\n...",
  "suggestions": [
    { "title": "Short title", "content": "Detailed description of the improvement suggestion" },
    { "title": "Short title", "content": "Detailed description of the improvement suggestion" },
    { "title": "Short title", "content": "Detailed description of the improvement suggestion" }
  ]
}

Rules:
- The mission field must be valid markdown with Purpose, Goals, Success Criteria, and Current Focus sections
- Goals and Success Criteria should use "- [ ]" checkbox syntax
- Each suggestion should be actionable and specific
- Respond ONLY with the JSON object, no other text`;

      const raw = await runClaude(prompt, generateTimeoutMs);
      const result = extractJson<MissionCreatorResult>(raw);

      // Validate shape
      if (!result.mission || !Array.isArray(result.suggestions)) {
        const preview = raw.slice(0, 300);
        return Response.json(
          { data: null, error: `AI returned invalid response shape. Preview: ${preview}` },
          { status: 502 },
        );
      }

      return Response.json({ data: result, error: null });
    } catch (err) {
      logHandlerError(_config.devDir, "mission-creator:POST", err);
      if (err instanceof Error && err.message === TIMEOUT_ERROR_MESSAGE) {
        return Response.json(
          {
            data: null,
            error: "AI mission generation timed out. Please try again or shorten the prompt.",
          },
          { status: 504 },
        );
      }
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "AI generation failed" },
        { status: 500 },
      );
    }
  }

  async function expand(request: Request): Promise<Response> {
    try {
      const expandTimeoutMs = timeoutMsFromEnv("SKYNET_MISSION_EXPAND_TIMEOUT_MS", DEFAULT_EXPAND_TIMEOUT_MS);
      const { data: body, error: parseError, status: parseStatus } = await parseBody<{
        suggestion?: string;
        currentMission?: string;
      }>(request);
      if (parseError || !body) {
        return Response.json({ data: null, error: parseError }, { status: parseStatus ?? 400 });
      }

      const { suggestion, currentMission } = body;
      if (!suggestion || typeof suggestion !== "string" || !suggestion.trim()) {
        return Response.json({ data: null, error: "Missing 'suggestion' field (string)" }, { status: 400 });
      }
      if (suggestion.length > 10_000) {
        return Response.json({ data: null, error: "Suggestion must be 10,000 characters or fewer" }, { status: 400 });
      }
      if (currentMission !== undefined && typeof currentMission !== "string") {
        return Response.json({ data: null, error: "'currentMission' must be a string" }, { status: 400 });
      }
      if (typeof currentMission === "string" && currentMission.length > 100_000) {
        return Response.json({ data: null, error: "currentMission must be 100,000 characters or fewer" }, { status: 400 });
      }

      const missionContext = currentMission
        ? `\n\nCurrent mission document:\n${currentMission}`
        : "";

      const prompt = `You are a mission architect. Given a mission and a suggested improvement, provide exactly 3 concrete sub-suggestions to implement it.${missionContext}

Suggestion to expand: ${suggestion}

You MUST respond with valid JSON matching this exact shape:
{
  "suggestions": [
    { "title": "Short title", "content": "Detailed description of the sub-improvement" },
    { "title": "Short title", "content": "Detailed description of the sub-improvement" },
    { "title": "Short title", "content": "Detailed description of the sub-improvement" }
  ]
}

Rules:
- Each sub-suggestion should be a concrete, actionable step to implement the parent suggestion
- Be specific and detailed
- Respond ONLY with the JSON object, no other text`;

      const raw = await runClaude(prompt, expandTimeoutMs);
      const result = extractJson<{ suggestions: Array<{ title: string; content: string }> }>(raw);

      if (!Array.isArray(result.suggestions)) {
        const preview = raw.slice(0, 300);
        return Response.json(
          { data: null, error: `AI returned invalid response shape. Preview: ${preview}` },
          { status: 502 },
        );
      }

      return Response.json({ data: result, error: null });
    } catch (err) {
      logHandlerError(_config.devDir, "mission-creator:expand", err);
      if (err instanceof Error && err.message === TIMEOUT_ERROR_MESSAGE) {
        return Response.json(
          {
            data: null,
            error: "AI suggestion expansion timed out. Please try again.",
          },
          { status: 504 },
        );
      }
      return Response.json(
        { data: null, error: err instanceof Error ? err.message : "AI expansion failed" },
        { status: 500 },
      );
    }
  }

  return { POST, expand };
}
