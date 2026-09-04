/* ============================================================
   The treemap.

   Binary split: sort descending, cut the run closest to half the
   weight, recurse across the longer axis. Cheap, stable, and the
   aspect ratios stay readable — which is the only thing that
   matters when the blocks have to carry labels.

   The property this must never lose is that AREA IS BYTES. A block
   that looks twice as big is twice as big. Every temptation to
   nudge a rectangle for looks — a minimum size, a bit of padding on
   the small ones — breaks the one claim that makes the Map worth
   having, so none of them are here.
   ============================================================ */

export type Rect = { x: number; y: number; w: number; h: number };
export type Weighted<T> = { v: number; d: T };
export type Placed<T> = Rect & { d: T };

function total<T>(items: Weighted<T>[]): number {
  return items.reduce((s, x) => s + x.v, 0);
}

export function treemap<T>(items: Weighted<T>[], area: Rect, out: Placed<T>[] = []): Placed<T>[] {
  if (!items.length || area.w <= 0 || area.h <= 0) return out;

  if (items.length === 1) {
    out.push({ ...area, d: items[0].d });
    return out;
  }

  const sum = total(items);
  if (sum <= 0) {
    /* Everything is zero bytes. Splitting by weight would divide by
     * zero, so fall back to equal slices rather than emitting NaN
     * rectangles that render as invisible blocks. */
    const step = area.w / items.length;
    items.forEach((it, i) => out.push({ x: area.x + i * step, y: area.y, w: step, h: area.h, d: it.d }));
    return out;
  }

  let acc = 0;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < items.length - 1; i++) {
    acc += items[i].v;
    const diff = Math.abs(acc / sum - 0.5);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }

  const a = items.slice(0, best + 1);
  const b = items.slice(best + 1);
  const share = total(a) / sum;

  if (area.w >= area.h) {
    treemap(a, { ...area, w: area.w * share }, out);
    treemap(b, { x: area.x + area.w * share, y: area.y, w: area.w * (1 - share), h: area.h }, out);
  } else {
    treemap(a, { ...area, h: area.h * share }, out);
    treemap(b, { x: area.x, y: area.y + area.h * share, w: area.w, h: area.h * (1 - share) }, out);
  }
  return out;
}

/** Sorting is the caller's job everywhere else, but the layout only
 *  behaves if the input is descending, so enforce it here. */
export function layout<T>(items: Weighted<T>[], area: Rect = { x: 0, y: 0, w: 100, h: 100 }): Placed<T>[] {
  return treemap([...items].sort((p, q) => q.v - p.v), area);
}
