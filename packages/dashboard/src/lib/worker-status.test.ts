import { describe, it, expect, afterEach } from "vitest";
import { getWorkerStatus } from "./worker-status";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("getWorkerStatus", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns running=false, pid=null for nonexistent lock file", () => {
    const result = getWorkerStatus("/tmp/nonexistent-lock-file-test-12345");
    expect(result).toEqual({ running: false, pid: null, ageMs: null });
  });

  it("returns running=false for invalid PID format (non-numeric)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "skynet-ws-test-"));
    const lockDir = join(tempDir, "test.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), "not-a-number\n");
    const result = getWorkerStatus(lockDir);
    expect(result).toEqual({ running: false, pid: null, ageMs: null });
  });

  it("returns running=true for our own PID (dir-based lock)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "skynet-ws-test-"));
    const lockDir = join(tempDir, "test.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
    const result = getWorkerStatus(lockDir);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(result.ageMs).toBeTypeOf("number");
    // Allow small negative values due to filesystem mtime precision
    expect(result.ageMs).toBeGreaterThanOrEqual(-100);
  });

  it("returns running=true for our own PID (file-based lock)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "skynet-ws-test-"));
    const lockFile = join(tempDir, "test.lock");
    writeFileSync(lockFile, `${process.pid}\n`);
    const result = getWorkerStatus(lockFile);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(result.ageMs).toBeTypeOf("number");
  });

  it("returns running=false for a PID that is not running", () => {
    tempDir = mkdtempSync(join(tmpdir(), "skynet-ws-test-"));
    const lockDir = join(tempDir, "test.lock");
    mkdirSync(lockDir);
    // Use a very high PID that's almost certainly not running
    writeFileSync(join(lockDir, "pid"), "4999999\n");
    const result = getWorkerStatus(lockDir);
    expect(result.running).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.ageMs).toBeNull();
  });
});
