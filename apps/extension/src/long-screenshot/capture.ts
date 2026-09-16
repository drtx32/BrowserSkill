import {
  collectVirtualizedSegments,
  type VirtualizedAdvance,
  type VirtualizedSegment,
} from "@browser-skill/vom";
import { frameSignature, isStaleFrame } from "./frame-freshness";
import { type FrameSignature } from "./manual";
import {
  type CapturePhase,
  type CaptureScope,
  type PageCommand,
  type PageMetrics,
  ScreenshotError,
} from "./types";

/** Round document boundaries once, so fractional zoom cannot accumulate seams. */
export function sliceForFrame(metrics: PageMetrics, covered: number, scale: number) {
  if (metrics.y > covered + 0.5) throw new ScreenshotError("changed");
  const end = Math.min(metrics.y + metrics.viewportHeight, metrics.height);
  // A tiny final scroll must still include the whole fixed footer. Redraw its
  // overlap rather than chopping it down to the last few uncovered rows.
  const footerStart =
    metrics.height - Math.min(metrics.viewportHeight, metrics.bottomOverlayHeight ?? 0);
  const start =
    end === metrics.height ? Math.min(covered, Math.max(metrics.y, footerStart)) : covered;
  const topPx = Math.round(start * scale);
  const bottomPx = Math.round(end * scale);
  return {
    sourceY: topPx - Math.round(metrics.y * scale),
    targetY: topPx,
    height: bottomPx - topPx,
    end,
  };
}

export function sameLayout(a: PageMetrics, b: PageMetrics, includePosition = true) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.innerWidth === b.innerWidth &&
    a.innerHeight === b.innerHeight &&
    a.dpr === b.dpr &&
    (!includePosition || (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5))
  );
}

export interface CaptureDeps {
  page(command: PageCommand): Promise<PageMetrics>;
  screenshot(): Promise<ImageBitmap>;
  write(
    bitmap: ImageBitmap,
    width: number,
    sourceY: number,
    targetY: number,
    height: number,
  ): Promise<void>;
  signal: AbortSignal;
  progress(phase: CapturePhase, progress: number, frames: number): void;
  checkpoint?(): Promise<void>;
  prepared?(): void;
  finished?(): boolean;
  scope?: CaptureScope;
  loadingTimeoutMs?: number;
  checkFreshness?: boolean;
  label: string;
  cancelLabel: string;
  /** Optional semantic-anchored path for nested/virtualized scroll containers. */
  virtualized?: VirtualizedVisualTraversal<unknown>;
}

export interface VirtualizedVisualSegment<T> extends VirtualizedSegment<T> {
  metrics: PageMetrics;
  /** Pixel coordinates in the output tile store. */
  sourceY: number;
  targetY: number;
  height: number;
}

export interface VirtualizedVisualTraversal<T> {
  read: (segment: number) => Promise<VirtualizedVisualSegment<T>>;
  advance: (segment: number) => Promise<VirtualizedAdvance | boolean>;
  fingerprint: (item: T) => string;
  maxSegments?: number;
  maxStalledSegments?: number;
}

export interface VirtualizedCaptureResult {
  width: number;
  height: number;
  complete: boolean;
  termination: "complete" | "max-segments" | "stalled" | "end-of-list" | "advance-failed" | "aborted";
}

/**
 * Capture semantic-anchored visual windows with the same bounded collector
 * used by VOM item collection. The ordinary document path below remains the
 * fast path when no virtualized traversal is supplied.
 */
export async function captureVirtualizedPage(
  deps: Omit<CaptureDeps, "virtualized"> & { virtualized: VirtualizedVisualTraversal<unknown> },
): Promise<VirtualizedCaptureResult> {
  let width = 0;
  let height = 0;
  try {
    await deps.page({ action: "begin", label: deps.label, cancelLabel: deps.cancelLabel, ...(deps.scope ? { scope: deps.scope } : {}) });
    const traversal = deps.virtualized;
    const windows = new Map<number, VirtualizedVisualSegment<unknown>>();
    const collected = await collectVirtualizedSegments({
      read: async (segment) => {
        const window = await traversal.read(segment);
        windows.set(segment, window);
        return window;
      },
      advance: traversal.advance,
      fingerprint: traversal.fingerprint,
      maxSegments: traversal.maxSegments,
      maxStalledSegments: traversal.maxStalledSegments,
      signal: deps.signal,
    });
    // Render the exact windows collected above. The traversal's read contract
    // is responsible for moving the nested container, so semantic and visual
    // window state stay anchored without a second scroll pass.
    for (let segment = 0; segment < collected.segments; segment += 1) {
      deps.signal.throwIfAborted();
      const window = windows.get(segment);
      if (!window) throw new ScreenshotError("changed");
      const bitmap = await deps.screenshot();
      try {
        if (!width) {
          width = bitmap.width;
        }
        height = Math.max(height, window.targetY + window.height);
        await deps.write(bitmap, width, window.sourceY, window.targetY, window.height);
        deps.progress("capturing", Math.min(99, Math.round(((segment + 1) / Math.max(1, collected.segments)) * 100)), segment + 1);
      } finally {
        bitmap.close();
      }
      if (window.complete) break;
    }
    deps.progress("complete", collected.complete ? 100 : 99, collected.segments);
    return { width, height, complete: collected.complete, termination: collected.termination };
  } finally {
    await deps.page({ action: "finish" }).catch(() => {});
  }
}

/** Capture one viewport at a time. Height may grow as lazy content is appended;
 * only viewport geometry and each individual exposure must remain stable. */
export async function capturePage(deps: CaptureDeps) {
  if (deps.virtualized) return captureVirtualizedPage(deps as Omit<CaptureDeps, "virtualized"> & { virtualized: VirtualizedVisualTraversal<unknown> });
  const { signal, page, progress } = deps;
  let covered = 0;
  let width = 0;
  let scale = 1;
  let frames = 0;
  let previousFrame: { y: number; pixels: FrameSignature } | undefined;
  let bottomWait: { height: number; since: number } | undefined;
  let baseline: PageMetrics | undefined;
  const checkpoint = async () => {
    signal.throwIfAborted();
    await deps.checkpoint?.();
    signal.throwIfAborted();
  };
  try {
    await checkpoint();
    let metrics = await page({
      action: "begin",
      label: deps.label,
      cancelLabel: deps.cancelLabel,
      ...(deps.scope ? { scope: deps.scope } : {}),
    });
    let previous = metrics;
    let repairThrough = 0;
    deps.prepared?.();
    let y = 0;
    let layoutFailures = 0;
    let staleFailures = 0;
    let final = false;
    while (true) {
      await checkpoint();
      if (covered && covered >= repairThrough && deps.finished?.()) break;
      metrics = await page({ action: "move", y, capture: true, final });
      if (baseline && !sameLayout({ ...baseline, height: metrics.height }, metrics, false))
        throw new ScreenshotError("changed");
      if (metrics.height < covered - 0.5) throw new ScreenshotError("changed");
      baseline ??= metrics;
      const tail = previous.tailStart ?? Math.max(0, previous.height - previous.viewportHeight);
      const grew = metrics.height > previous.height + 0.5;
      previous = grew
        ? metrics
        : { ...metrics, tailStart: Math.min(tail, metrics.tailStart ?? tail) };
      if (grew && covered > tail) {
        // Insertions move an ordinary in-flow footer. Repaint the old tail from
        // its original position; appending alone would leave that footer inside
        // the image. Reuse disk tiles, keeping only one viewport in memory.
        repairThrough = Math.max(repairThrough, covered);
        covered = tail;
        y = tail;
        final = false;
        continue;
      }
      // A loading indicator or recent layout/content changes keeps the bottom
      // provisional. Checkpoints still allow pause, Finish and cancellation.
      if (final && metrics.bottomReady === false && covered >= metrics.height - 0.5) {
        if (!metrics.loading) bottomWait = undefined;
        else {
          if (!bottomWait || bottomWait.height !== metrics.height)
            bottomWait = { height: metrics.height, since: performance.now() };
          if (
            deps.loadingTimeoutMs !== undefined &&
            performance.now() - bottomWait.since >= deps.loadingTimeoutMs
          )
            throw new ScreenshotError("timeout", "loading_stalled");
        }
        continue;
      }
      bottomWait = undefined;
      const bitmap = await deps.screenshot();
      try {
        signal.throwIfAborted();
        const after = await page({ action: "inspect" });
        if (final && after.bottomReady === false) continue;
        if (!sameLayout(metrics, after)) {
          staleFailures = 0;
          if (++layoutFailures >= 3) throw new ScreenshotError("changed");
          continue;
        }
        layoutFailures = 0;
        if (!frames) {
          scale = bitmap.width / metrics.innerWidth;
          width = Math.round(metrics.viewportWidth * scale);
        }
        if (
          Math.abs(bitmap.width - metrics.innerWidth * scale) > 1 ||
          Math.abs(bitmap.height - metrics.innerHeight * scale) > 1
        )
          throw new ScreenshotError("changed");
        const pixels = deps.checkFreshness ? frameSignature(bitmap) : undefined;
        if (
          pixels &&
          previousFrame &&
          isStaleFrame(
            previousFrame.pixels,
            pixels,
            Math.round((metrics.y - previousFrame.y) * scale),
          )
        ) {
          if (++staleFailures >= 3) throw new ScreenshotError("captureFailed", "stale_frame");
          continue;
        }
        staleFailures = 0;
        const slice = sliceForFrame(metrics, covered, scale);
        if (slice.sourceY < 0 || slice.sourceY + slice.height > bitmap.height || slice.height < 0)
          throw new ScreenshotError("changed");
        if (slice.height) {
          await deps.write(bitmap, width, slice.sourceY, slice.targetY, slice.height);
          covered = slice.end;
          frames++;
        }
        if (pixels) previousFrame = { y: metrics.y, pixels };
        progress("capturing", Math.min(99, Math.round((covered / metrics.height) * 100)), frames);
      } finally {
        bitmap.close();
      }
      if (covered >= metrics.height - 0.5) {
        // A second stable bottom exposure catches appended content and includes
        // the fixed footer exactly once. Disk tiles allow rewriting that overlap.
        if (final) break;
        final = true;
        y = metrics.y;
      } else {
        final = false;
        y = Math.max(0, covered - Math.floor(metrics.viewportHeight * 0.15));
        if (y <= metrics.y && covered < metrics.height) throw new ScreenshotError("unsupported");
      }
    }
    return { width, height: Math.round(covered * scale) };
  } finally {
    await page({ action: "finish" }).catch(() => {});
  }
}
