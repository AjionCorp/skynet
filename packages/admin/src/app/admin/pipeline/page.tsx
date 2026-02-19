import { Suspense } from "react";
import { PipelineDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function PipelinePage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <PipelineDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
