import type { Metrics, Outlook } from "../../api/types";
import { useApi } from "../../api/useApi";
import { ChartFrame } from "../../components/charts/ChartFrame";
import { OutlookChart, OutlookTable } from "../../components/charts/OutlookChart";
import { InlineError, Skeleton } from "../../components/feedback";
import { raceShort } from "../../lib/format";
import { outlookContenders } from "../../lib/forecast";

function horizonSentence(metrics: Metrics | undefined): string | null {
  const hs = metrics?.horizons;
  if (!hs || hs.length < 2) return null;
  const sorted = [...hs].sort((a, b) => a.h - b.h);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const ahead = (h: number) => (h === 1 ? "one race" : `${["", "one", "two", "three", "four", "five", "six"][h] ?? h} races`);
  return `Test-season log-loss rises from ${first.logloss.toFixed(2)} ${ahead(first.h)} ahead to ${last.logloss.toFixed(2)} ${ahead(last.h)} ahead.`;
}

export function SeasonOutlook() {
  const outlook = useApi<Outlook>("/api/outlook");
  const metrics = useApi<Metrics>("/api/metrics");
  const data = outlook.data;
  const contenders = data ? outlookContenders(data) : [];
  const horizon = horizonSentence(metrics.data);

  return (
    <section aria-labelledby="outlook-title" className="flex flex-col gap-3">
      <div>
        <h2 id="outlook-title" className="m-0 text-lg font-semibold text-ink-1">
          Rest of the season
        </h2>
        {data ? (
          <p className="m-0 mt-0.5 text-[13px] text-ink-muted">
            {data.races.length
              ? `${data.races.length} ${data.races.length === 1 ? "race" : "races"} left after ${raceShort(data.after)}`
              : `No races left after ${raceShort(data.after)}`}
          </p>
        ) : null}
      </div>

      {outlook.error && !data ? <InlineError error={outlook.error} onRetry={outlook.refetch} title="Could not load the season outlook" /> : null}

      {outlook.isFirstLoad ? (
        <div aria-hidden className="flex flex-col gap-2.5 pt-2">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5" style={{ width: `${Math.max(6, 60 - i * 8)}%` }} />
            </div>
          ))}
        </div>
      ) : null}

      {data && data.races.length === 0 ? <p className="m-0 text-sm text-ink-2">The season is complete. The next forecast needs next season's calendar.</p> : null}

      {data && data.races.length > 0 ? (
        <div className={`transition-opacity duration-200 ${outlook.isStale ? "opacity-60" : ""}`}>
          <ChartFrame
            id="outlook"
            title="Expected wins over the remaining races"
            subtitle="Drivers with at least 0.05 expected wins. Sum of each race's win probability."
            table={<OutlookTable outlook={data} />}
            caption={
              <>
                Forecasts for later races reuse today's form, so every remaining race gets nearly the same odds.
                {horizon ? ` ${horizon}` : null}
              </>
            }
          >
            {contenders.length ? (
              <OutlookChart outlook={data} drivers={contenders} />
            ) : (
              <p className="m-0 text-sm text-ink-2">No driver reaches 0.05 expected wins. Use the table for every driver.</p>
            )}
          </ChartFrame>
        </div>
      ) : null}
    </section>
  );
}
