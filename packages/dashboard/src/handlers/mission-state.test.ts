import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMissionStateHandler } from "./mission-state";
import type { SkynetConfig } from "../types";

vi.mock("../lib/file-reader", () => ({
  readDevFile: vi.fn(() => ""),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));

import { readDevFile } from "../lib/file-reader";
import { existsSync, readFileSync, writeFileSync } from "fs";

const mockReadDevFile = vi.mocked(readDevFile);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function makeConfig(overrides?: Partial<SkynetConfig>): SkynetConfig {
  return {
    projectName: "test-project", devDir: "/tmp/test/.dev", lockPrefix: "/tmp/skynet-test-",
    workers: [{ name: "dev-worker-1", label: "Dev Worker 1", category: "core", schedule: "On demand", description: "Implements tasks" }],
    triggerableScripts: [], taskTags: ["FEAT", "FIX"], ...overrides,
  };
}

describe("createMissionStateHandler", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.clearAllMocks();
    mockReadDevFile.mockReturnValue("");
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
    mockWriteFileSync.mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe("GET", () => {
    it("returns { data: { state: null }, error: null } when mission.md is empty", async () => {
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.error).toBeNull();
      expect(body.data.state).toBeNull();
    });

    it("parses ## State: ACTIVE from mission file", async () => {
      mockReadDevFile.mockReturnValue("# Mission\n## State: ACTIVE\n## Purpose\nBuild things.\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.state).toBe("ACTIVE");
    });

    it("parses ## State: PAUSED from mission file", async () => {
      mockReadDevFile.mockReturnValue("# Mission\n## State: PAUSED\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.state).toBe("PAUSED");
    });

    it("parses ## State: COMPLETE from mission file", async () => {
      mockReadDevFile.mockReturnValue("# Mission\n## State: COMPLETE\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.state).toBe("COMPLETE");
    });

    it("parses legacy State: VALUE format without ## prefix", async () => {
      mockReadDevFile.mockReturnValue("# Mission\nState: ACTIVE\n## Purpose\nStuff.\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.state).toBe("ACTIVE");
    });

    it("returns null state when no State: line exists", async () => {
      mockReadDevFile.mockReturnValue("# Mission\n## Purpose\nBuild things.\n## Goals\n1. Ship it\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(data.state).toBeNull();
    });

    it("response shape has only state key in data", async () => {
      mockReadDevFile.mockReturnValue("## State: ACTIVE\n");
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const { data } = await res.json();
      expect(Object.keys(data)).toEqual(["state"]);
    });

    it("reads from the correct devDir", async () => {
      const handler = createMissionStateHandler(makeConfig({ devDir: "/custom/.dev" }));
      await handler.GET();
      expect(mockReadDevFile).toHaveBeenCalledWith("/custom/.dev", "mission.md");
    });

    it("returns 500 with detailed error in development when readDevFile throws", async () => {
      mockReadDevFile.mockImplementation(() => { throw new Error("ENOENT: no such file"); });
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("ENOENT: no such file");
    });

    it("returns 500 with generic error in production when readDevFile throws", async () => {
      process.env.NODE_ENV = "production";
      mockReadDevFile.mockImplementation(() => { throw new Error("ENOENT: no such file"); });
      const handler = createMissionStateHandler(makeConfig());
      const res = await handler.GET();
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.data).toBeNull();
      expect(body.error).toBe("Failed to read mission state");
    });
  });

  describe("POST", () => {
    it("updates existing ## State: line in mission file", async () => {
      const original = "# Mission\n## State: ACTIVE\n## Purpose\nBuild things.\n";
      mockExistsSync.mockReturnValue(false);
      // The resolveMissionPath falls back to mission.md path
      // readFileSync is called to read the file before updating
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === "/tmp/test/.dev/mission.md") return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(original);
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "PAUSED" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.state).toBe("PAUSED");
      expect(body.error).toBeNull();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "# Mission\n## State: PAUSED\n## Purpose\nBuild things.\n",
        "utf-8",
      );
    });

    it("inserts state line after first heading when no State: line exists", async () => {
      const original = "# My Mission\n## Purpose\nBuild things.\n";
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === "/tmp/test/.dev/mission.md") return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(original);
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "ACTIVE" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.state).toBe("ACTIVE");
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "# My Mission\n## State: ACTIVE\n## Purpose\nBuild things.\n",
        "utf-8",
      );
    });

    it("inserts state line at top when no heading exists", async () => {
      const original = "Just some text without headings\n";
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === "/tmp/test/.dev/mission.md") return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(original);
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "ACTIVE" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "## State: ACTIVE\nJust some text without headings\n",
        "utf-8",
      );
    });

    it("handles empty file (file does not exist)", async () => {
      mockExistsSync.mockReturnValue(false);
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "ACTIVE" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.state).toBe("ACTIVE");
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "## State: ACTIVE\n",
        "utf-8",
      );
    });

    it("returns 400 when state field is missing", async () => {
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wrong: "field" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'state' field (string)");
    });

    it("returns 400 when state is empty string", async () => {
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe("Missing 'state' field (string)");
    });

    it("returns 400 for invalid state value", async () => {
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "INVALID" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toContain("Invalid state 'INVALID'");
      expect(body.error).toContain("ACTIVE");
    });

    it("returns 400 when body is invalid JSON", async () => {
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await handler.POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 500 when writeFileSync throws", async () => {
      mockExistsSync.mockReturnValue(false);
      mockWriteFileSync.mockImplementation(() => { throw new Error("Permission denied"); });
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "ACTIVE" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(500);
      expect(body.error).toBe("Permission denied");
    });

    it("updates legacy State: line (without ##) to ## State: format", async () => {
      const original = "# Mission\nState: ACTIVE\n## Purpose\nBuild things.\n";
      mockExistsSync.mockImplementation((p) => {
        if (String(p) === "/tmp/test/.dev/mission.md") return true;
        return false;
      });
      mockReadFileSync.mockReturnValue(original);
      const handler = createMissionStateHandler(makeConfig());
      const req = new Request("http://localhost/api/admin/mission/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "COMPLETE" }),
      });
      const res = await handler.POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.state).toBe("COMPLETE");
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/tmp/test/.dev/mission.md",
        "# Mission\n## State: COMPLETE\n## Purpose\nBuild things.\n",
        "utf-8",
      );
    });
  });
});
