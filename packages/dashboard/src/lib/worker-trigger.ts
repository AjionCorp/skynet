const TRIGGERABLE_SCRIPTS = new Set([
  "dev-worker",
  "task-fixer",
  "project-driver",
  "sync-runner",
  "ui-tester",
  "feature-validator",
  "health-check",
]);

const NUMBERED_WORKER_PATTERN = /^(dev-worker|task-fixer)-(\d+)$/;

export interface WorkerTriggerTarget {
  script: string;
  args: string[];
}

export function getWorkerTriggerTarget(
  workerName: string,
): WorkerTriggerTarget | null {
  const numberedWorkerMatch = workerName.match(NUMBERED_WORKER_PATTERN);
  if (numberedWorkerMatch) {
    return {
      script: numberedWorkerMatch[1],
      args: [numberedWorkerMatch[2]],
    };
  }

  if (TRIGGERABLE_SCRIPTS.has(workerName)) {
    return { script: workerName, args: [] };
  }

  return null;
}

export function isWorkerTriggerable(workerName: string): boolean {
  return getWorkerTriggerTarget(workerName) !== null;
}
