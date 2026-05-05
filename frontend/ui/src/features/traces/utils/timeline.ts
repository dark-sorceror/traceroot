import type { Span } from "@/types/api";
import { buildChildrenMap, parseTimestamp } from "../utils";

export interface TimelineMetrics {
  startOffsetPx: number;
  widthPx: number;
  durationMs: number;
  isInProgress: boolean;
  isPending: boolean;
  isInstant: boolean;
}

export interface FlatTimelineItem {
  span: Span;
  metrics: TimelineMetrics;
}

/**
 * Flattens a flat array of spans into a DFS-ordered list for virtualized rendering,
 * pre-computing pixel offsets and widths for the Gantt bars.
 */
export function flattenTreeWithMetrics(
  spans: Span[],
  collapsedIds: Set<string>,
  traceDurationMs: number,
  scaleWidth: number,
  now: number = Date.now(),
): FlatTimelineItem[] {
  if (!spans || spans.length === 0) return [];

  // Cache parsed timestamps to avoid re-parsing during traversal
  const startTimes = new Map<string, number>();
  const endTimes = new Map<string, number>();

  for (const span of spans) {
    startTimes.set(span.span_id, parseTimestamp(span.span_start_time));

    if (span.span_end_time) {
      endTimes.set(span.span_id, parseTimestamp(span.span_end_time));
    }
  }

  const traceStartMs = spans.reduce(
    (min, s) => Math.min(min, startTimes.get(s.span_id)!),
    Infinity,
  );

  const childrenMap = buildChildrenMap(spans);
  const spanIds = new Set(spans.map((s) => s.span_id));

  for (const children of childrenMap.values()) {
    children.sort((a, b) => startTimes.get(a.span_id)! - startTimes.get(b.span_id)!);
  }

  // True roots + orphan spans (parent not yet arrived), sorted by time
  const trueRoots = childrenMap.get(null) ?? [];
  const orphans = spans.filter((s) => s.parent_span_id !== null && !spanIds.has(s.parent_span_id));
  const topLevel = [...trueRoots, ...orphans].sort(
    (a, b) => startTimes.get(a.span_id)! - startTimes.get(b.span_id)!,
  );

  const flatList: FlatTimelineItem[] = [];
  const safeTraceDuration = Math.max(1, traceDurationMs);

  const traceEndMs = traceStartMs + safeTraceDuration;

  const descendantEndCache = new Map<string, number | null>();

  /**
   * Pending placeholder spans do not have their own real end time.
   * Bound them by their descendant spans instead of letting them grow forever via now.
   */
  function getMaxDescendantEndMs(spanId: string): number | null {
    if (descendantEndCache.has(spanId)) return descendantEndCache.get(spanId) ?? null;

    let maxEndMs: number | null = null;
    const stack = [...(childrenMap.get(spanId) ?? [])];

    while (stack.length > 0) {
      const child = stack.pop()!;

      let childEndMs: number | null = null;

      if (child.span_end_time) {
        childEndMs = endTimes.get(child.span_id) ?? parseTimestamp(child.span_end_time);
      } else if (!child.pending) {
        // Real open span: still genuinely in progress.
        childEndMs = now;
      }

      if (childEndMs != null) {
        maxEndMs = maxEndMs == null ? childEndMs : Math.max(maxEndMs, childEndMs);
      }

      if (descendantEndCache.has(child.span_id)) {
        const childSubtreeMax = descendantEndCache.get(child.span_id) ?? null;
        if (childSubtreeMax != null) {
          maxEndMs = maxEndMs == null ? childSubtreeMax : Math.max(maxEndMs, childSubtreeMax);
        }
      } else {
        stack.push(...(childrenMap.get(child.span_id) ?? []));
      }
    }

    descendantEndCache.set(spanId, maxEndMs);
    return maxEndMs;
  }

  function getTimelineDurationMs(span: Span, offsetMs: number): number {
    const startMs = startTimes.get(span.span_id)!;

    let endMs: number;

    if (span.span_end_time) {
      endMs = endTimes.get(span.span_id) ?? parseTimestamp(span.span_end_time);
    } else if (span.pending) {
      // Placeholder span: use descendants or cap to trace end.
      endMs = getMaxDescendantEndMs(span.span_id) ?? traceEndMs;
    } else {
      // Real span still running.
      endMs = now;
    }

    // Never let any bar exceed the trace row.
    const boundedEndMs = Math.min(endMs, traceEndMs);

    // Also guard against bars extending past the trace duration because of offset.
    const maxDurationFromOffset = Math.max(0, safeTraceDuration - offsetMs);

    return Math.min(Math.max(0, boundedEndMs - startMs), maxDurationFromOffset);
  }

  function isSpanActuallyInProgress(span: Span): boolean {
    if (span.span_end_time) return false;

    // Pending placeholders are layout placeholders, not true running spans.
    if (span.pending) {
      const descendantEndMs = getMaxDescendantEndMs(span.span_id);
      return descendantEndMs == null;
    }

    return true;
  }

  // Iterative DFS — avoids stack overflow on deeply-nested traces (recursive
  // agents, deep ReAct loops). Children are pushed in reverse so the first
  // child is popped first, preserving chronological DFS order.
  const stack: Span[] = [];
  for (let i = topLevel.length - 1; i >= 0; i--) {
    stack.push(topLevel[i]);
  }

  while (stack.length > 0) {
    const span = stack.pop()!;

    const offsetMs = startTimes.get(span.span_id)! - traceStartMs;
    const durationMs = getTimelineDurationMs(span, offsetMs);
    const isInProgress = isSpanActuallyInProgress(span);

    const startOffsetPx = (offsetMs / safeTraceDuration) * scaleWidth;
    const widthPx = (durationMs / safeTraceDuration) * scaleWidth;
    const isInstant = !isInProgress && (widthPx < 2 || durationMs / safeTraceDuration < 0.002);

    flatList.push({
      span,
      metrics: {
        startOffsetPx: Math.max(0, startOffsetPx),
        widthPx: Math.max(0, widthPx),
        durationMs,
        isInProgress,
        isPending: span.pending === true,
        isInstant,
      },
    });

    if (!collapsedIds.has(span.span_id)) {
      const children = childrenMap.get(span.span_id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }

  return flatList;
}
