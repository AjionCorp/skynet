import { Suspense } from "react";
import { SyncDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function SyncPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <SyncDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
