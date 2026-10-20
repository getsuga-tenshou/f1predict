import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getJSON, postJSON } from "../../api/client";
import type { Run, RunAccepted, RunRequest } from "../../api/types";
import { primeCache, refetchWhere } from "../../api/useApi";

export type Submission =
  | { kind: "idle" }
  | { kind: "active"; request: RunRequest; startedAt: number; runId: string | null; stage: string | null }
  | { kind: "error"; request: RunRequest; message: string };

const POLL_MS = 800;

const refreshRunList = () => refetchWhere((url) => url === "/api/runs");

/**
 * Submit a run and poll it until it is done or failed. Polling stops on done/error and when
 * the component using this hook unmounts.
 */
export function useRunSubmission(onDone: (run: Run) => void) {
  const [state, setState] = useState<Submission>({ kind: "idle" });
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const poll = useCallback((request: RunRequest, startedAt: number, id: string) => {
    getJSON<Run>(`/api/runs/${id}`)
      .then((run) => {
        if (!alive.current) return;
        if (run.status === "done") {
          primeCache(`/api/runs/${id}`, run);
          refreshRunList();
          setState({ kind: "idle" });
          doneRef.current(run);
        } else if (run.status === "error") {
          refreshRunList();
          setState({ kind: "error", request, message: run.error ?? "The run failed without a message." });
        } else {
          setState({ kind: "active", request, startedAt, runId: id, stage: run.stage });
          timer.current = window.setTimeout(() => poll(request, startedAt, id), POLL_MS);
        }
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setState({ kind: "error", request, message: errorMessage(err) });
      });
  }, []);

  const submit = useCallback(
    (request: RunRequest) => {
      const startedAt = Date.now();
      setState({ kind: "active", request, startedAt, runId: null, stage: "Submitting" });
      postJSON<RunAccepted>("/api/runs", request)
        .then((acc) => {
          if (!alive.current) return;
          refreshRunList();
          setState({ kind: "active", request, startedAt, runId: acc.id, stage: null });
          poll(request, startedAt, acc.id);
        })
        .catch((err: unknown) => {
          if (!alive.current) return;
          setState({ kind: "error", request, message: errorMessage(err) });
        });
    },
    [poll],
  );

  const dismiss = useCallback(() => setState({ kind: "idle" }), []);

  return { state, submit, dismiss };
}
