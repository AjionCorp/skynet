import { Suspense } from "react";
import { WorkerScaling, WorkerIntents } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function WorkersPage() {
  return (
    <div className="space-y-6">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSkeleton />}>
          <WorkerScaling />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary>
        <Suspense fallback={<LoadingSkeleton />}>
          <WorkerIntents />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
