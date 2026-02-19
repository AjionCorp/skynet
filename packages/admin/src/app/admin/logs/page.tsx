import { Suspense } from "react";
import { LogViewer } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function LogsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <LogViewer />
      </Suspense>
    </ErrorBoundary>
  );
}
