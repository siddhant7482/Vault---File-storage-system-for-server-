"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  acceptSuggestionAction,
  fileAction,
  pinAction,
  revokeShareAction,
  shareAction,
  trashAction,
} from "@/app/actions";
import { layout } from "@/components/treemap";
import { bytes as fmtBytes, held, opened, shortDate } from "@/lib/format";
import type { MapData, ObjectRow, TreeNode, UnfiledRow } from "@/lib/vault";

/* ============================================================
   The panel.

   One client component rather than several, because nearly every
   interaction crosses what would otherwise be a component boundary:
   clicking a block on the Map selects a row in the index, which
   fills the detail pane, which the palette can also drive. Splitting
   that into four components connected by lifted state would be more
   files saying the same thing.

   Everything it renders arrives from the server already computed —
   the byte arithmetic, the cold cutoff, the folder rollups. The
   client's only jobs are layout, selection and calling actions.
   ============================================================ */

export type PanelData = {
  tree: TreeNode[];
  inboxCount: number;
  unfiled: UnfiledRow[];
  rows: ObjectRow[];
  total: number;
  scopedBytes: number;
  map: MapData;
  driver: string;
  storageOk: boolean;
  lastScanAt: string | null;
  suggestionsOn: boolean;
};

type Scope = { top: string; sub: string | null } | null;
type View = "map" | "list";

/** Patterns are assigned by position, so adding a folder never means
 *  editing CSS. Six is plenty — past that they stop being
 *  distinguishable and a seventh would be a lie. */
const PATTERNS = ["f1", "f2", "f3", "f4", "f5", "f6"] as const;

export default function Panel(props: PanelData) {
  const [scope, setScope] = useState<Scope>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("map");
  const [cold, setCold] = useState(false);
  const [selId, setSelId] = useState<number | null>(props.rows[0]?.id ?? null);
  const [open, setOpen] = useState<Set<string>>(new Set([props.tree[0]?.path ?? ""]));
  const [palette, setPalette] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [pending, start] = useTransition();

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  /* Pattern per top-level folder, resolved once. The Inbox is not a
   * folder and never gets one — it is amber or it is nothing. */
  const patternOf = useMemo(() => {
    const m = new Map<string, string>();
    props.tree.forEach((t, i) => m.set(t.name, PATTERNS[i % PATTERNS.length]));
    return m;
  }, [props.tree]);

  /* ---------- filtering happens here, not on the server ----------
     The server sends the scoped page; narrowing further as you type is
     instant and does not need a round trip. Searching outside the
     current scope is what the palette is for. */
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return props.rows.filter((r) => {
      if (cold && !r.cold) return false;
      if (scope) {
        const path = scope.sub ? `${scope.top}/${scope.sub}` : scope.top;
        if (!r.folderPath || (r.folderPath !== path && !r.folderPath.startsWith(path + "/"))) return false;
      }
      if (!needle) return true;
      return (r.name + " " + (r.folderPath ?? "")).toLowerCase().includes(needle);
    });
  }, [props.rows, q, cold, scope]);

  const selected = useMemo(
    () => rows.find((r) => r.id === selId) ?? rows[0] ?? null,
    [rows, selId],
  );

  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === selId)) setSelId(rows[0].id);
  }, [rows, selId]);

  /* ---------- ⌘K ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- drag and drop upload ---------- */
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      for (const f of files) {
        say(`UPLOADING ${f.name}`);
        const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, {
          method: "POST",
          body: f,
          headers: { "content-length": String(f.size) },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          say(body.detail || body.error || "UPLOAD FAILED", true);
          return;
        }
      }
      say(`${files.length} TO INBOX`);
      window.location.reload();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [say]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      say(r.message, !r.ok);
    });

  const scopeLabel = scope ? (scope.sub ?? scope.top) : "All";
  const scopedBytes = rows.reduce((n, r) => n + r.bytes, 0);

  return (
    <div className="z">
      <div className="bar">
        <div className="mark">Vault</div>
        <div className="desig">
          VLT-105 · STORE · {props.driver.toUpperCase()}
        </div>
        <div className="lamps">
          <div className={`lamp${props.storageOk ? "" : " dead"}`}>
            <i />
            {props.storageOk ? "LINK" : "NO LINK"}
          </div>
          <div className={`lamp${props.lastScanAt ? "" : " dead"}`}>
            <i />
            {props.lastScanAt ? `SCAN ${shortDate(props.lastScanAt)}` : "NEVER SCANNED"}
          </div>
          <div className={`lamp${props.inboxCount ? " warn" : " dead"}`}>
            <i />
            INBOX {props.inboxCount}
          </div>
        </div>
      </div>

      <div className="app">
        <Nav
          tree={props.tree}
          inbox={props.inboxCount}
          map={props.map}
          patternOf={patternOf}
          scope={scope}
          openSet={open}
          onToggle={(path) =>
            setOpen((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })
          }
          onScope={(s) => {
            setScope(s);
            say(s ? `${s.top}${s.sub ? "/" + s.sub : ""}`.toUpperCase() : "ALL");
          }}
        />

        <main className="main">
          <div className="crumbs">
            <span>VAULT</span>
            {scope && <span>/ {scope.top.toUpperCase()}</span>}
            {scope?.sub && <span className="now">/ {scope.sub.toUpperCase()}</span>}
          </div>

          <div className="search">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Query names, volumes, tags"
              autoComplete="off"
              aria-label="Search"
            />
            <div className="kbd">
              <b>⌘</b>
              <b>K</b>
            </div>
          </div>

          <Inbox
            items={props.unfiled}
            tree={props.tree}
            suggestionsOn={props.suggestionsOn}
            pending={pending}
            onAccept={(id) => run(() => acceptSuggestionAction(id))}
            onFile={(id, folder) => run(() => fileAction(id, folder))}
          />

          <div className="head">
            <h2>{scopeLabel}</h2>
            <span className="sub">
              {rows.length} OBJ · {fmtBytes(scopedBytes)}
            </span>
            <span className="sp" />
            <button className="tog" aria-pressed={cold} onClick={() => setCold((c) => !c)}>
              <i />
              Cold
            </button>
            <div className="seg2">
              <button data-v="map" aria-pressed={view === "map"} onClick={() => setView("map")}>
                Plot
              </button>
              <button data-v="list" aria-pressed={view === "list"} onClick={() => setView("list")}>
                Index
              </button>
            </div>
          </div>

          {view === "map" ? (
            <Plot
              map={props.map}
              patternOf={patternOf}
              cold={cold}
              selId={selId}
              onPick={(id) => {
                if (id === null) return;
                setSelId(id);
                setView("list");
              }}
              onGroup={(top) => setScope({ top, sub: null })}
            />
          ) : (
            <Index rows={rows} patternOf={patternOf} selId={selected?.id ?? null} onPick={setSelId} />
          )}
        </main>

        <Detail
          row={selected}
          allocation={props.map.allocationBytes}
          pending={pending}
          onShare={(id) =>
            start(async () => {
              const r = await shareAction(id);
              if (r.ok && r.path) {
                await navigator.clipboard.writeText(window.location.origin + r.path).catch(() => {});
              }
              say(r.message, !r.ok);
            })
          }
          onRevoke={(id) => run(() => revokeShareAction(id))}
          onPin={(id, p) => run(() => pinAction(id, p))}
          onTrash={(id) => run(() => trashAction(id))}
          onOpen={async (id, download) => {
            const res = await fetch(`/api/objects/${id}/url?intent=open${download ? "&download=1" : ""}`);
            if (!res.ok) return say("COULD NOT OPEN", true);
            const { url } = await res.json();
            window.open(url, "_blank", "noopener");
          }}
        />
      </div>

      {palette && (
        <Palette
          tree={props.tree}
          rows={props.rows}
          patternOf={patternOf}
          onClose={() => setPalette(false)}
          onScope={(s) => setScope(s)}
          onPick={(id) => {
            setScope(null);
            setQ("");
            setSelId(id);
            setView("list");
          }}
          onCold={() => setCold((c) => !c)}
          onView={setView}
        />
      )}

      {dragging && <div className="drop">Drop to inbox</div>}
      <div className="toast" data-on={!!toast} data-bad={toast?.bad ? "true" : undefined}>
        {toast?.text ?? ""}
      </div>
    </div>
  );
}

/* ---------------- sidebar ---------------- */

function Nav({
  tree,
  inbox,
  map,
  patternOf,
  scope,
  openSet,
  onToggle,
  onScope,
}: {
  tree: TreeNode[];
  inbox: number;
  map: MapData;
  patternOf: Map<string, string>;
  scope: Scope;
  openSet: Set<string>;
  onToggle: (path: string) => void;
  onScope: (s: Scope) => void;
}) {
  const usedGb = map.usedBytes / 1024 ** 3;
  const allocGb = map.allocationBytes / 1024 ** 3;
  /* Ticks at 0 / third / two thirds / full, whatever the allocation is —
   * hardcoding 0-10-20-30 would lie the moment the ceiling changes. */
  const ticks = [0, allocGb / 3, (allocGb * 2) / 3, allocGb];

  return (
    <nav className="nav">
      <span className="cap">Volumes</span>

      <button
        className="fold inbox"
        aria-current={scope === null}
        onClick={() => onScope(null)}
      >
        <span className="tw" />
        <span className="sw" />
        <span className="nm">Inbox</span>
        <span className="n">{inbox}</span>
      </button>

      {tree.map((t) => {
        const isOpen = openSet.has(t.path);
        return (
          <div key={t.id}>
            <button
              className="fold"
              data-open={isOpen}
              aria-current={scope?.top === t.name && !scope.sub}
              onClick={() => {
                if (t.children.length) onToggle(t.path);
                onScope({ top: t.name, sub: null });
              }}
            >
              <span className="tw">{t.children.length ? "›" : ""}</span>
              <span className={`sw ${patternOf.get(t.name)}`} />
              <span className="nm">{t.name}</span>
              <span className="n">{t.count.toLocaleString()}</span>
            </button>
            {isOpen && t.children.length > 0 && (
              <div className="kids">
                {t.children.map((k) => (
                  <button
                    key={k.id}
                    className="fold"
                    aria-current={scope?.top === t.name && scope.sub === k.name}
                    onClick={() => onScope({ top: t.name, sub: k.name })}
                  >
                    <span className="tw" />
                    <span className={`sw ${patternOf.get(t.name)}`} />
                    <span className="nm">{k.name}</span>
                    <span className="n">{k.count.toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="gauge brk">
        <span className="cap">Allocation</span>
        <div className="fig">
          {usedGb.toFixed(1)}
          <b>GB</b>
        </div>
        <div className="of">
          OF {allocGb.toFixed(0)} · {fmtBytes(map.freeBytes)} FREE
        </div>

        <div className="track">
          {map.groups.map((g) => (
            <i
              key={g.top}
              className={patternOf.get(g.top) ?? "f6"}
              style={{ width: `${(g.bytes / map.allocationBytes) * 100}%` }}
            />
          ))}
        </div>
        <div className="ticks">
          {ticks.map((t, i) => (
            <span key={i}>{t.toFixed(0)}</span>
          ))}
        </div>

        <div className="keys">
          {map.groups.map((g) => (
            <div className="key" key={g.top}>
              <i className={`sw ${patternOf.get(g.top) ?? "f6"}`} />
              <s>{g.top}</s>
              <span>{fmtBytes(g.bytes)}</span>
            </div>
          ))}
          <div className="key">
            <i className="sw" style={{ borderStyle: "dashed" }} />
            <s>Free</s>
            <span>{fmtBytes(map.freeBytes)}</span>
          </div>
        </div>
      </div>
    </nav>
  );
}

/* ---------------- inbox ---------------- */

function Inbox({
  items,
  tree,
  suggestionsOn,
  pending,
  onAccept,
  onFile,
}: {
  items: UnfiledRow[];
  tree: TreeNode[];
  suggestionsOn: boolean;
  pending: boolean;
  onAccept: (id: number) => void;
  onFile: (id: number, folder: string) => void;
}) {
  /* Flattened folder list for the manual override dropdown. */
  const paths = useMemo(() => {
    const out: string[] = [];
    for (const t of tree) {
      out.push(t.path);
      for (const k of t.children) out.push(k.path);
    }
    return out;
  }, [tree]);

  if (!items.length) {
    return (
      <div className="inbox clear">
        <div className="in-h">
          <span className="ttl">Inbox</span>
          <span className="note">CLEAR · 0 HELD</span>
        </div>
      </div>
    );
  }

  return (
    <div className="inbox">
      <div className="in-h">
        <span className="ttl">Inbox</span>
        <span className="badge">{items.length} HELD</span>
        <span className="note">OLDEST {held(items[0].addedAt)}</span>
      </div>

      {items.map((u) => {
        const s = u.suggestion;
        return (
          <div className="un" key={u.id}>
            <div className="body">
              <div className="nm">{u.name}</div>
              <div className="meta">
                {(u.ext ?? u.kind).toUpperCase()} · {fmtBytes(u.bytes)} · HELD {held(u.addedAt)}
              </div>

              {s ? (
                <div className="route">
                  <span className="arrow">→</span>
                  <span className="to">{s.folder.toUpperCase()}</span>
                  <span className="arrow">AS</span>
                  <span className="as">{s.name}</span>
                </div>
              ) : (
                <div className="route">
                  <span className="as">
                    {suggestionsOn ? "NO SUGGESTION YET" : "SUGGESTIONS OFF"}
                  </span>
                </div>
              )}

              {/* A duplicate is worth saying BEFORE the file is put away. */}
              {u.duplicateOfKey && (
                <div className="dupe">
                  ALREADY IN VAULT · SAME CONTENTS AS {u.duplicateOfKey.toUpperCase()}
                </div>
              )}
            </div>

            {s && (
              <button className="btn" disabled={pending} onClick={() => onAccept(u.id)}>
                File
              </button>
            )}

            <select
              className="btn g"
              defaultValue=""
              disabled={pending || !paths.length}
              onChange={(e) => {
                if (e.target.value) onFile(u.id, e.target.value);
                e.target.value = "";
              }}
              aria-label={`File ${u.name} elsewhere`}
            >
              <option value="" disabled>
                {s ? "Alt" : "File to…"}
              </option>
              {paths.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- the map ---------------- */

function Plot({
  map,
  patternOf,
  cold,
  selId,
  onPick,
  onGroup,
}: {
  map: MapData;
  patternOf: Map<string, string>;
  cold: boolean;
  selId: number | null;
  onPick: (id: number | null) => void;
  onGroup: (top: string) => void;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const hRef = useRef<HTMLElement>(null);
  const vRef = useRef<HTMLElement>(null);
  const [hint, setHint] = useState<{ x: number; y: number; block: (typeof blocks)[number] } | null>(null);

  /* Two passes: volumes first, then the files inside each volume's
     rectangle — so the plot IS the folder tree, drawn to scale. */
  const blocks = useMemo(() => {
    const groups = layout(
      [
        ...map.groups.map((g) => ({ v: g.bytes, d: g })),
        { v: map.freeBytes, d: null },
      ],
      { x: 0, y: 0, w: 100, h: 100 },
    );

    const out: {
      id: number | null;
      name: string;
      top: string | null;
      bytes: number;
      cold: boolean;
      linked: boolean;
      count: number;
      rect: { x: number; y: number; w: number; h: number };
    }[] = [];

    for (const g of groups) {
      if (!g.d) {
        out.push({
          id: null,
          name: "Free",
          top: null,
          bytes: map.freeBytes,
          cold: false,
          linked: false,
          count: 0,
          rect: { x: g.x, y: g.y, w: g.w, h: g.h },
        });
        continue;
      }
      const inner = layout(
        g.d.blocks.map((b) => ({ v: b.bytes, d: b })),
        { x: g.x, y: g.y, w: g.w, h: g.h },
      );
      for (const r of inner) {
        out.push({
          id: r.d.id,
          name: r.d.name,
          top: r.d.top,
          bytes: r.d.bytes,
          cold: r.d.cold,
          linked: r.d.linked,
          count: r.d.count,
          rect: { x: r.x, y: r.y, w: r.w, h: r.h },
        });
      }
    }
    return out;
  }, [map]);

  const allocGb = map.allocationBytes / 1024 ** 3;
  const step = allocGb <= 12 ? 2 : allocGb <= 40 ? 5 : 10;
  const scaleTicks: number[] = [];
  for (let g = 0; g <= allocGb; g += step) scaleTicks.push(g);

  return (
    <>
      <div
        className="plot brk"
        ref={plotRef}
        onMouseMove={(e) => {
          const r = plotRef.current?.getBoundingClientRect();
          if (!r) return;
          if (hRef.current) hRef.current.style.top = `${e.clientY - r.top}px`;
          if (vRef.current) vRef.current.style.left = `${e.clientX - r.left}px`;
        }}
      >
        <div className="mapwrap full" data-cold={cold}>
          {blocks.map((b, i) => {
            const style = {
              left: `${b.rect.x}%`,
              top: `${b.rect.y}%`,
              width: `${b.rect.w}%`,
              height: `${b.rect.h}%`,
            };
            const big = b.rect.w > 7 && b.rect.h > 11;

            if (b.top === null) {
              return (
                <div className="blk free" style={style} key="free">
                  {b.rect.w > 12 && b.rect.h > 16 && (
                    <span className="t">
                      Free<s>{fmtBytes(b.bytes)}</s>
                    </span>
                  )}
                </div>
              );
            }

            return (
              <button
                key={`${b.top}-${b.id ?? "tail"}-${i}`}
                className={`blk ${patternOf.get(b.top) ?? "f6"}${b.cold ? " icy" : ""}`}
                style={style}
                aria-pressed={b.id !== null && b.id === selId}
                aria-label={`${b.name}, ${fmtBytes(b.bytes)}`}
                onClick={() => (b.id === null ? onGroup(b.top!) : onPick(b.id))}
                onMouseMove={(e) => setHint({ x: e.clientX, y: e.clientY, block: b })}
                onMouseLeave={() => setHint(null)}
              >
                {b.linked && <span className="pin" />}
                {big && (
                  <span className="t">
                    {b.name.replace(/\.[a-z0-9]+$/i, "")}
                    <s>{fmtBytes(b.bytes)}</s>
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="ret">
          <i className="h" ref={hRef as React.RefObject<HTMLElement>} />
          <i className="v" ref={vRef as React.RefObject<HTMLElement>} />
        </div>

        {/* A real scale, in GB, against the allocation. */}
        <div className="scale">
          {scaleTicks.map((g) => {
            const pct = 100 - (g / allocGb) * 100;
            const major = g % (step * 2) === 0;
            return (
              <span key={g}>
                <i style={{ top: `${pct}%`, width: major ? 12 : 6 }} />
                {major && <b style={{ top: `${Math.min(97, Math.max(3, pct))}%` }}>{g}</b>}
              </span>
            );
          })}
        </div>
      </div>

      <div className="legend">
        {map.groups.map((g) => (
          <span className="lg" key={g.top}>
            <i className={`sw ${patternOf.get(g.top) ?? "f6"}`} />
            {g.top}
          </span>
        ))}
        <span className="lg">
          <i className="sw" style={{ background: "var(--amber)", borderColor: "var(--amber)" }} />
          Linked
        </span>
        <span className="coldline">
          COLD {fmtBytes(map.coldBytes)} ·{" "}
          {map.usedBytes ? Math.round((map.coldBytes / map.usedBytes) * 100) : 0}% OF STORED
        </span>
      </div>

      {hint && (
        <div
          className="hint"
          data-on="true"
          style={{
            left: Math.min(hint.x + 14, window.innerWidth - 262),
            top: Math.min(hint.y + 14, window.innerHeight - 84),
          }}
        >
          <div className="h1">{hint.block.name}</div>
          <div className="h2">
            {hint.block.top?.toUpperCase()} · {fmtBytes(hint.block.bytes)} ·{" "}
            {((hint.block.bytes / map.allocationBytes) * 100).toFixed(1)}%
          </div>
          {hint.block.cold && <div className="h3">COLD · NEVER OPENED</div>}
          {hint.block.count > 1 && <div className="h2">{hint.block.count} FILES</div>}
        </div>
      )}
    </>
  );
}

/* ---------------- index ---------------- */

function Index({
  rows,
  patternOf,
  selId,
  onPick,
}: {
  rows: ObjectRow[];
  patternOf: Map<string, string>;
  selId: number | null;
  onPick: (id: number) => void;
}) {
  if (!rows.length) {
    return <div className="none" style={{ padding: "1.1rem .7rem" }}>NO MATCH</div>;
  }
  return (
    <div className="rows">
      {rows.map((r) => {
        const top = r.folderPath?.split("/")[0] ?? "Inbox";
        return (
          <button
            key={r.id}
            className="row"
            aria-pressed={r.id === selId}
            onClick={() => onPick(r.id)}
          >
            <span className={`sw ${patternOf.get(top) ?? "f6"}`} />
            <span className="nm">
              {r.name}
              <i>{(r.folderPath ?? "INBOX").toUpperCase()}</i>
            </span>
            {r.cold && <span className="icy">COLD</span>}
            {r.refApps.length > 0 && <span className="link" title={r.refApps.join(", ")} />}
            <span className="k">{(r.ext ?? r.kind).toUpperCase()}</span>
            <span className="m">{fmtBytes(r.bytes)}</span>
            <span className="m">{shortDate(r.addedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- detail ---------------- */

function Detail({
  row,
  allocation,
  pending,
  onShare,
  onRevoke,
  onPin,
  onTrash,
  onOpen,
}: {
  row: ObjectRow | null;
  allocation: number;
  pending: boolean;
  onShare: (id: number) => void;
  onRevoke: (id: number) => void;
  onPin: (id: number, pinned: boolean) => void;
  onTrash: (id: number) => void;
  onOpen: (id: number, download: boolean) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  /* Previews use intent=preview so that glancing at a thumbnail does
     NOT clear the file's cold flag. */
  useEffect(() => {
    setPreview(null);
    if (!row || row.kind !== "image") return;
    let alive = true;
    fetch(`/api/objects/${row.id}/url?intent=preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setPreview(j.url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [row]);

  if (!row) {
    return (
      <aside className="detail">
        <span className="cap">No selection</span>
      </aside>
    );
  }

  return (
    <aside className="detail">
      <h3>{row.name}</h3>
      <div className="path">{(row.folderPath ?? "INBOX").toUpperCase()}</div>

      <div className="prev brk">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" />
        ) : row.kind === "document" ? (
          "PAGE 1"
        ) : (
          "NO PREVIEW"
        )}
      </div>

      <div className="kv">
        <span>Type</span>
        <span>{(row.ext ?? row.kind).toUpperCase()}</span>
      </div>
      <div className="kv">
        <span>Size</span>
        <span>{fmtBytes(row.bytes)}</span>
      </div>
      <div className="kv">
        <span>Alloc</span>
        <span>{((row.bytes / allocation) * 100).toFixed(1)}%</span>
      </div>
      <div className="kv">
        <span>Added</span>
        <span>{shortDate(row.addedAt)}</span>
      </div>
      <div className="kv">
        <span>Opened</span>
        <span>{opened(row.lastOpenedAt)}</span>
      </div>

      {row.cold && (
        <div className="coldflag">
          COLD · NEVER OPENED
          <br />
          {fmtBytes(row.bytes)} · {((row.bytes / allocation) * 100).toFixed(1)}% OF ALLOC
        </div>
      )}

      <div className="block">
        <span className="cap">Linked</span>
        {row.refApps.length ? (
          row.refApps.map((a) => (
            <div className="refline" key={a}>
              <i />
              {a.toUpperCase()}
            </div>
          ))
        ) : (
          <div className="none">NONE</div>
        )}
      </div>

      <div className="block">
        <span className="cap">Share</span>
        <div className="none" style={{ color: row.shared === "active" ? "var(--amber)" : undefined }}>
          {row.shared === "active" ? "LINK ACTIVE" : row.shared === "expired" ? "LINK EXPIRED" : "NEVER"}
        </div>
      </div>

      <div className="acts">
        <button className="btn" disabled={pending} onClick={() => onShare(row.id)}>
          Link
        </button>
        <button className="btn g" disabled={pending} onClick={() => onOpen(row.id, true)}>
          Get
        </button>
        {row.shared === "active" && (
          <button className="btn g" disabled={pending} onClick={() => onRevoke(row.id)}>
            Revoke
          </button>
        )}
        <button className="btn g" disabled={pending} onClick={() => onPin(row.id, !row.pinned)}>
          {row.pinned ? "Unpin" : "Pin"}
        </button>
        <button className="btn g" disabled={pending} onClick={() => onTrash(row.id)}>
          Trash
        </button>
      </div>
    </aside>
  );
}

/* ---------------- command palette ---------------- */

function Palette({
  tree,
  rows,
  patternOf,
  onClose,
  onScope,
  onPick,
  onCold,
  onView,
}: {
  tree: TreeNode[];
  rows: ObjectRow[];
  patternOf: Map<string, string>;
  onClose: () => void;
  onScope: (s: Scope) => void;
  onPick: (id: number) => void;
  onCold: () => void;
  onView: (v: View) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo(() => {
    const out: { kind: string; label: string; pattern?: string; sub?: string; go: () => void }[] = [];
    for (const t of tree) {
      out.push({ kind: "volume", label: t.name, pattern: patternOf.get(t.name), go: () => onScope({ top: t.name, sub: null }) });
      for (const k of t.children) {
        out.push({
          kind: "volume",
          label: `${t.name} / ${k.name}`,
          pattern: patternOf.get(t.name),
          go: () => onScope({ top: t.name, sub: k.name }),
        });
      }
    }
    for (const r of rows) {
      out.push({
        kind: "file",
        label: r.name,
        sub: fmtBytes(r.bytes),
        pattern: patternOf.get(r.folderPath?.split("/")[0] ?? "Inbox"),
        go: () => onPick(r.id),
      });
    }
    out.push({ kind: "command", label: "Cold filter", go: onCold });
    out.push({ kind: "command", label: "Plot view", go: () => onView("map") });
    out.push({ kind: "command", label: "Index view", go: () => onView("list") });
    out.push({ kind: "command", label: "Clear filter", go: () => onScope(null) });

    const needle = q.trim().toLowerCase();
    return out.filter((i) => !needle || i.label.toLowerCase().includes(needle)).slice(0, 24);
  }, [tree, rows, q, patternOf, onScope, onPick, onCold, onView]);

  const fire = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.go();
  };

  let lastKind = "";

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              fire(sel);
            }
          }}
          placeholder="Volume, file, or command"
          autoComplete="off"
        />
        <div className="list">
          {items.length === 0 && <div className="grp cap">No match</div>}
          {items.map((it, i) => {
            const header = it.kind !== lastKind ? ((lastKind = it.kind), it.kind) : null;
            return (
              <div key={`${it.kind}-${it.label}-${i}`}>
                {header && <div className="grp cap">{header}s</div>}
                <button className="it" data-on={i === sel} onClick={() => fire(i)}>
                  <span className={`sw ${it.pattern ?? ""}`} />
                  <span>{it.label}</span>
                  {it.sub && <span className="sub">{it.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="foot">
          <span>↑↓ MOVE</span>
          <span>↵ EXEC</span>
          <span>ESC ABORT</span>
        </div>
      </div>
    </div>
  );
}
