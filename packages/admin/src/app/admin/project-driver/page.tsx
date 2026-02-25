import { Suspense } from "react";
import { ProjectDriverDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function ProjectDriverPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <ProjectDriverDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
