import { Suspense } from "react";
import { PromptsDashboard } from "@ajioncorp/skynet/components";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingSkeleton } from "@/components/LoadingSkeleton";

export default function PromptsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSkeleton />}>
        <PromptsDashboard />
      </Suspense>
    </ErrorBoundary>
  );
}
