"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Span, TraceDetail } from "@/types/api";
import { enrichSpansWithPending } from "../utils";

/**
 * Merge incoming spans into existing spans array.
 * Incoming spans replace existing ones with the same span_id — real spans replace placeholders.
 */
function mergeSpans(existing: Span[], incoming: Span[]): Span[] {
  const incomingIds = new Set(incoming.map((s) => s.span_id));
  return [...existing.filter((s) => !incomingIds.has(s.span_id)), ...incoming];
}

interface UseTraceStreamResult {
  isStreaming: boolean;
}

/**
 * Hook that connects to the live trace SSE endpoint and merges incoming spans
 * into the React Query cache for the trace detail.
 *
 * When new spans arrive via SSE, the existing useQuery data for
 * ["trace", projectId, traceId] is updated in-place, causing SpanTreeView
 * and SpanInfoPanel to re-render automatically.
 */
export function useTraceStream(
  projectId: string,
  traceId: string,
  enabled: boolean,
): UseTraceStreamResult {
  const queryClient = useQueryClient();
  const [isStreaming, setIsStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const refetchTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !projectId || !traceId) {
      return;
    }

    const url = `/api/projects/${projectId}/traces/${traceId}/live`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("spans", (event) => {
      try {
        const data = JSON.parse(event.data);
        const newSpans: Span[] = data.spans ?? [];

        if (newSpans.length === 0) return;

        setIsStreaming(true);

        queryClient.setQueryData<TraceDetail>(["trace", projectId, traceId], (prev: TraceDetail | undefined) => {
          if (!prev) return prev;
          const merged = mergeSpans(prev.spans, newSpans);
          return {
            ...prev,
            spans: enrichSpansWithPending(merged),
          };
        });
      } catch {
        // Ignore malformed events
      }
    });

    es.addEventListener("trace_complete", (event) => {
      setIsStreaming(false);

      try {
        const data = JSON.parse(event.data || "{}");
        const finalSpans: Span[] = data.spans ?? [];

        if (finalSpans.length > 0) {
          queryClient.setQueryData<TraceDetail>(["trace", projectId, traceId], (prev: TraceDetail | undefined) => {
            if (!prev) return prev;
            const merged = mergeSpans(prev.spans, finalSpans);
            return {
              ...prev,
              spans: enrichSpansWithPending(merged),
            };
          });
        }
      } catch {
        // Completion events may not include JSON payloads.
      }

      es.close();
      eventSourceRef.current = null;

      // Refetch immediately, then once more shortly after to avoid racing ClickHouse insertion.
      void queryClient.invalidateQueries({
        queryKey: ["trace", projectId, traceId],
        refetchType: "active",
      });

      refetchTimerRef.current = window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ["trace", projectId, traceId],
          refetchType: "active",
        });
      }, 500);
    });

    es.onerror = () => {
      setIsStreaming(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsStreaming(false);
      if (refetchTimerRef.current != null) {
        window.clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [projectId, traceId, enabled, queryClient]);

  return { isStreaming };
}
