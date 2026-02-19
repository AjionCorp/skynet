import { Suspense } from "react";
import { TasksDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function TasksPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <TasksDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
