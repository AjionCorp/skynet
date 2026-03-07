export interface WorkerTriggerSpec {
  script: string;
  args: string[];
}

const DIRECT_TRIGGERABLE_WORKERS = new Set([
  "project-driver",
  "sync-runner",
  "ui-tester",
  "feature-validator",
  "health-check",
]);

export function getWorkerTriggerSpec(workerName: string): WorkerTriggerSpec | null {
  if (workerName === "task-fixer") {
    return { script: "task-fixer", args: [] };
  }

  const numberedWorkerMatch = workerName.match(/^(dev-worker|task-fixer)-(\d+)$/);
  if (numberedWorkerMatch) {
    return {
      script: numberedWorkerMatch[1],
      args: [numberedWorkerMatch[2]],
    };
  }

  if (DIRECT_TRIGGERABLE_WORKERS.has(workerName)) {
    return { script: workerName, args: [] };
  }

  return null;
}
