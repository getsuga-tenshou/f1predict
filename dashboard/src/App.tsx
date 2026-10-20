import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import type { Status } from "./api/types";
import { useApi } from "./api/useApi";
import { Button } from "./components/Button";
import { Header } from "./components/Header";
import { useRoute } from "./hooks/useRoute";
import { ForecastSkeleton } from "./views/forecast/ForecastPanel";
import { ForecastView } from "./views/forecast/ForecastView";
import { HistoryView } from "./views/history/HistoryView";

function ServerDown({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="m-0 text-2xl font-semibold tracking-tight text-ink-1">The model server is not responding</h1>
      <p className="m-0 text-sm text-ink-2">Start it from the project folder, then retry:</p>
      <code className="rounded-control border border-hair bg-surface px-3 py-2 font-mono text-[13px] text-ink-1">f1predict dashboard</code>
      <Button variant="primary" onClick={onRetry} disabled={retrying} icon={<ArrowClockwiseIcon size={16} aria-hidden />}>
        {retrying ? "Retrying" : "Retry"}
      </Button>
    </div>
  );
}

export function App() {
  const [route] = useRoute();
  const status = useApi<Status>("/api/status");

  useEffect(() => {
    document.title = route.view === "history" ? "History, f1predict" : "Forecast, f1predict";
  }, [route.view]);

  let content;
  if (status.data) {
    content =
      route.view === "forecast" ? (
        <ForecastView status={status.data} routeRaceId={route.raceId} />
      ) : (
        <HistoryView status={status.data} raceId={route.raceId} routeMode={route.mode} routeScope={route.scope} />
      );
  } else if (status.error) {
    content = <ServerDown onRetry={status.refetch} retrying={status.isLoading} />;
  } else {
    content = <ForecastSkeleton />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only rounded-control bg-ink-1 px-3 py-2 text-sm text-surface focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[var(--z-popover)]"
      >
        Skip to content
      </a>
      <div className="min-h-[100dvh] bg-page">
        <Header status={status.data} view={route.view} />
        <main id="main" tabIndex={-1} className="mx-auto max-w-[1400px] px-4 py-6 outline-none sm:px-6 lg:py-8 xl:px-8">
          {content}
        </main>
      </div>
    </MotionConfig>
  );
}
