import { Suspense } from "react";
import { WorkerScaling } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function WorkersPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <WorkerScaling />
      </Suspense>
    </ErrorBoundary>
  );
}
