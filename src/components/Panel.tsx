"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  acceptSuggestionAction,
  createFolderAction,
  deleteFolderAction,
  fileAction,
  pinAction,
  renameFolderAction,
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

/** One queued upload. `folder` is set only for files that came out of a
 *  dropped directory; loose files carry null and land in the Inbox. */
/** Percentages that never round a real file down to nothing. */
function share(part: number, whole: number): string {
  if (!whole || !part) return "0%";
  const pct = (part / whole) * 100;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  return "<0.1%";
}

type Upload = { file: File; folder: string | null };
type Progress = { done: number; total: number; name: string; pct: number; bytes: number };

/**
 * XMLHttpRequest rather than fetch, for one reason: fetch cannot report
 * upload progress. A 2 GB archive with no feedback is indistinguishable
 * from a hung app, and this is exactly the kind of file this vault is
 * for.
 *
 * It also sets Content-Length itself, which fetch refuses to let you do
 * — and the route needs that header to check the allocation BEFORE
 * writing a byte rather than after.
 */
function putFile(item: Upload, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ name: item.file.name });
    if (item.folder) q.set("folder", item.folder);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?${q}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let detail = `HTTP ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText);
        detail = body.detail || body.error || detail;
      } catch {
        /* not JSON — keep the status */
      }
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(item.file);
  });
}

/**
 * Turns dropped directories into a flat list of files, each remembering
 * the top-level folder it came from.
 *
 * readEntries() returns at most 100 entries per call and signals the end
 * with an empty batch, which is why this loops rather than reading once.
 * Getting that wrong silently uploads the first hundred photos of a
 * folder and drops the rest.
 */
async function walkEntries(entries: FileSystemEntry[]): Promise<Upload[]> {
  const out: Upload[] = [];

  const walk = async (entry: FileSystemEntry, folder: string | null): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push({ file, folder });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      /* Nested subfolders collapse into their top-level parent — the
         store is two levels deep by design, and a dropped tree should
         not be able to smuggle a deeper one in. */
      for (const child of batch) await walk(child, folder);
    }
  };

  for (const e of entries) await walk(e, e.isDirectory ? e.name : null);
  return out;
}

export default function Panel(props: PanelData) {
  const [scope, setScope] = useState<Scope>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("map");
  const [cold, setCold] = useState(false);
  const [selId, setSelId] = useState<number | null>(props.rows[0]?.id ?? null);
  const [open, setOpen] = useState<Set<string>>(new Set([props.tree[0]?.path ?? ""]));
  const [palette, setPalette] = useState(false);
  /* Narrow screens cannot afford three permanent columns, so the tree
     becomes a drawer and the detail pane becomes a sheet. Both are
     inert above the breakpoint — the same markup, different CSS. */
  const [navOpen, setNavOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const pickerRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

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

  /* ---------- uploading ----------
     Sequential, not parallel. The route deduplicates a name against
     whatever is already at the destination, so two uploads racing can
     both be told "nothing called this exists yet" and one of them ends
     up as "file (2)" for no reason. Slower and correct beats faster
     and occasionally wrong. */
  const uploadAll = useCallback(
    async (items: Upload[]) => {
      if (!items.length) return;

      const totalBytes = items.reduce((n, i) => n + i.file.size, 0);
      if (totalBytes > props.map.freeBytes) {
        say(`NEEDS ${fmtBytes(totalBytes)} · ONLY ${fmtBytes(props.map.freeBytes)} FREE`, true);
        return;
      }

      const failed: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        setProgress({ done: i, total: items.length, name: it.file.name, pct: 0, bytes: totalBytes });
        try {
          await putFile(it, (pct) =>
            setProgress({ done: i, total: items.length, name: it.file.name, pct, bytes: totalBytes }),
          );
        } catch (e) {
          /* One bad file must not abandon the other forty. Collect and
             report at the end. */
          failed.push(`${it.file.name}: ${e instanceof Error ? e.message : e}`);
        }
      }
      setProgress(null);

      if (failed.length === items.length) {
        say(failed[0].slice(0, 80), true);
      } else if (failed.length) {
        say(`${items.length - failed.length} OF ${items.length} · ${failed.length} FAILED`, true);
      } else {
        const folders = new Set(items.map((i) => i.folder).filter(Boolean));
        say(
          folders.size === 1
            ? `${items.length} TO ${[...folders][0]!.toUpperCase()}`
            : `${items.length} TO INBOX`,
        );
      }
      router.refresh();
    },
    [props.map.freeBytes, say, router],
  );

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
      if (!e.dataTransfer) return;
      /* Must read the entries synchronously — the DataTransfer is
         neutered the moment this handler yields. */
      const entries = Array.from(e.dataTransfer.items)
        .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
        .filter((x): x is FileSystemEntry => !!x);
      const loose = Array.from(e.dataTransfer.files);

      const items = entries.length ? await walkEntries(entries) : loose.map((file) => ({ file, folder: null }));
      await uploadAll(items);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [uploadAll]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      say(r.message, !r.ok);
    });

  const scopeLabel = scope ? (scope.sub ?? scope.top) : "All";
  const scopedBytes = rows.reduce((n, r) => n + r.bytes, 0);

  /* Selecting anything is what opens the sheet on a phone. On desktop
     the pane is always there and this flag is ignored. */
  const select = useCallback((id: number) => {
    setSelId(id);
    setSheetOpen(true);
  }, []);

  return (
    <div className="z" data-nav={navOpen} data-sheet={sheetOpen}>
      <div className="bar">
        <button
          className="navbtn"
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Volumes"
          aria-expanded={navOpen}
        >
          <span /><span /><span />
        </button>
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
          pending={pending}
          onCreate={(path) => run(() => createFolderAction(path))}
          onRenameFolder={(id, name) => run(() => renameFolderAction(id, name))}
          onDeleteFolder={(id) => run(() => deleteFolderAction(id))}
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
            setNavOpen(false);
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
            onAdd={() => pickerRef.current?.click()}
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
                select(id);
                setView("list");
              }}
              onGroup={(top) => setScope({ top, sub: null })}
            />
          ) : (
            <>
              {/* Same correction as the plot: the strip carries "how
                  full", so the index does not need a minimap that would
                  be one grey rectangle at low utilisation. */}
              <div className="alloc" style={{ marginBottom: "0.9rem" }}>
                <div className="alloc-track">
                  {props.map.groups.map((g) => (
                    <i
                      key={g.top}
                      className={patternOf.get(g.top) ?? "f6"}
                      style={{ width: `${(g.bytes / props.map.allocationBytes) * 100}%` }}
                      title={`${g.top} ${fmtBytes(g.bytes)}`}
                    />
                  ))}
                </div>
                <div className="alloc-read">
                  <span>
                    {fmtBytes(props.map.usedBytes)} OF {fmtBytes(props.map.allocationBytes)}
                  </span>
                  <span className="cold-read">
                    COLD {fmtBytes(props.map.coldBytes)} ·{" "}
                    {props.map.usedBytes
                      ? Math.round((props.map.coldBytes / props.map.usedBytes) * 100)
                      : 0}
                    % OF STORED
                  </span>
                </div>
              </div>
              <Index rows={rows} patternOf={patternOf} selId={selected?.id ?? null} onPick={select} />
            </>
          )}
        </main>

        <Detail
          row={selected}
          allocation={props.map.allocationBytes}
          pending={pending}
          onClose={() => setSheetOpen(false)}
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

            /* NOT window.open(). Fetching the signed URL is async, which
             * breaks the user-gesture chain, and every popup blocker
             * then kills the window silently — the button appears to do
             * nothing at all.
             *
             * A download carries content-disposition: attachment, so
             * navigating to it downloads without leaving the page. An
             * inline open needs a real anchor click, which browsers
             * still honour after an await. */
            if (download) {
              window.location.href = url;
              return;
            }
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
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
            select(id);
            setView("list");
          }}
          onCold={() => setCold((c) => !c)}
          onView={setView}
        />
      )}

      {/* One picker for both buttons. `multiple` is the whole point of
          the control; a file store where you add things one at a time
          is a file store you stop using. */}
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []).map((file) => ({ file, folder: null }));
          e.target.value = "";
          void uploadAll(files);
        }}
      />

      {/* Tap-outside-to-close, and it keeps the drawer from being a
          trap on a phone. Inert above the breakpoint. */}
      <div className="scrim-nav" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="scrim-sheet" onClick={() => setSheetOpen(false)} aria-hidden="true" />

      {dragging && <div className="drop">Drop files or a folder</div>}

      {progress && (
        <div className="uploading">
          <div className="up-head">
            <span>
              UPLOADING {progress.done + 1} / {progress.total}
            </span>
            <span>{fmtBytes(progress.bytes)}</span>
          </div>
          <div className="up-name">{progress.name}</div>
          <div className="up-track">
            <i style={{ width: `${progress.pct}%` }} />
          </div>
        </div>
      )}
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
  pending,
  openSet,
  onToggle,
  onScope,
  onCreate,
  onRenameFolder,
  onDeleteFolder,
}: {
  tree: TreeNode[];
  inbox: number;
  map: MapData;
  patternOf: Map<string, string>;
  scope: Scope;
  pending: boolean;
  openSet: Set<string>;
  onToggle: (path: string) => void;
  onScope: (s: Scope) => void;
  onCreate: (path: string) => void;
  onRenameFolder: (id: number, name: string) => void;
  onDeleteFolder: (id: number) => void;
}) {
  /* One inline field rather than a modal or a prompt(). A modal is a
     lot of chrome for one string, and prompt() looks like 1998 sitting
     on top of an instrument panel. */
  const [entry, setEntry] = useState<{ mode: "new" | "rename"; id?: number; value: string } | null>(null);
  const entryRef = useRef<HTMLInputElement>(null);
  useEffect(() => entryRef.current?.focus(), [entry?.mode, entry?.id]);

  const selectedFolder = useMemo(() => {
    if (!scope) return null;
    for (const t of tree) {
      if (t.name === scope.top && !scope.sub) return t;
      if (t.name === scope.top && scope.sub) return t.children.find((k) => k.name === scope.sub) ?? null;
    }
    return null;
  }, [tree, scope]);

  const submit = () => {
    if (!entry || !entry.value.trim()) return setEntry(null);
    if (entry.mode === "new") onCreate(entry.value.trim());
    else if (entry.id !== undefined) onRenameFolder(entry.id, entry.value.trim());
    setEntry(null);
  };

  /* Forcing GB here printed "0.0 GB" for a vault holding 2 MB, which
     reads as broken rather than as empty. fmtBytes picks the unit that
     makes the number meaningful and the display splits it, so the
     numeral stays the big thing on the panel. */
  const [usedValue, usedUnit] = fmtBytes(map.usedBytes).split(" ");
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

      {/* Folder maintenance. NEW takes a path — "Documents/Legal" — so
          making a subfolder is the same gesture as making a top-level
          one, and the field says so. */}
      <div className="foldbar">
        <button className="mini" disabled={pending} onClick={() => setEntry({ mode: "new", value: selectedFolder && !scope?.sub ? `${scope!.top}/` : "" })}>
          New
        </button>
        <button
          className="mini"
          disabled={pending || !selectedFolder}
          onClick={() => selectedFolder && setEntry({ mode: "rename", id: selectedFolder.id, value: selectedFolder.name })}
        >
          Rename
        </button>
        <button
          className="mini"
          disabled={pending || !selectedFolder}
          onClick={() => selectedFolder && onDeleteFolder(selectedFolder.id)}
        >
          Drop
        </button>
      </div>

      {entry && (
        <input
          ref={entryRef}
          className="foldentry"
          value={entry.value}
          placeholder={entry.mode === "new" ? "Documents/Legal" : "New name"}
          onChange={(e) => setEntry({ ...entry, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") setEntry(null);
          }}
          onBlur={submit}
          aria-label={entry.mode === "new" ? "New folder path" : "Rename folder"}
        />
      )}

      <div className="gauge brk">
        <span className="cap">Allocation</span>
        <div className="fig">
          {usedValue}
          <b>{usedUnit}</b>
        </div>
        <div className="of">
          OF {allocGb.toFixed(0)} GB · {fmtBytes(map.freeBytes)} FREE
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
  onAdd,
}: {
  items: UnfiledRow[];
  tree: TreeNode[];
  suggestionsOn: boolean;
  pending: boolean;
  onAccept: (id: number) => void;
  onFile: (id: number, folder: string) => void;
  onAdd: () => void;
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
          <button className="btn g" onClick={onAdd}>
            Add files
          </button>
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
        <button className="btn g" onClick={onAdd}>
          Add files
        </button>
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
     rectangle — so the plot IS the folder tree, drawn to scale.

     FREE SPACE IS NOT IN HERE, and that is a correction. It used to be
     a block like any other, which is honest arithmetic and a useless
     picture: at 2 MB stored against a 30 GB allocation the real files
     get 0.004% of the area each and the plot renders as one grey
     rectangle. Free space beat everything you own by four orders of
     magnitude.

     So the two questions are drawn separately now. The plot answers
     "what am I storing, and what is big" — area is bytes among the
     things that exist. The strip underneath answers "how full am I",
     which is one number and only ever needed one dimension. Both stay
     exactly proportional; neither has to lose to the other. */
  const blocks = useMemo(() => {
    const groups = layout(
      map.groups.map((g) => ({ v: g.bytes, d: g })),
      { x: 0, y: 0, w: 100, h: 100 },
    );

    const out: {
      id: number | null;
      name: string;
      top: string;
      bytes: number;
      cold: boolean;
      linked: boolean;
      count: number;
      rect: { x: number; y: number; w: number; h: number };
    }[] = [];

    for (const g of groups) {
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

  /* The scale measures what the plot actually draws — stored bytes.
     Ticking it against the allocation while the plot no longer contains
     free space would put every block in the bottom 0.01% of a ruler. */
  const storedMb = map.usedBytes / 1024 ** 2;
  const niceStep = (mb: number) => {
    const target = mb / 4;
    const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1024, 2048, 5120, 10240, 25600, 51200];
    return steps.find((x) => x >= target) ?? 51200;
  };
  const stepMb = niceStep(storedMb || 1);
  const scaleTicks: number[] = [];
  for (let v = 0; v <= storedMb; v += stepMb) scaleTicks.push(v);

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
          {blocks.length === 0 && (
            <div className="plot-empty">
              <span className="cap">Nothing stored</span>
              <span>Drop files anywhere, or use ADD FILES.</span>
            </div>
          )}
          {blocks.map((b, i) => {
            const style = {
              left: `${b.rect.x}%`,
              top: `${b.rect.y}%`,
              width: `${b.rect.w}%`,
              height: `${b.rect.h}%`,
            };
            const big = b.rect.w > 7 && b.rect.h > 11;

            return (
              <button
                key={`${b.top}-${b.id ?? "tail"}-${i}`}
                className={`blk ${patternOf.get(b.top) ?? "f6"}${b.cold ? " icy" : ""}`}
                style={style}
                aria-pressed={b.id !== null && b.id === selId}
                aria-label={`${b.name}, ${fmtBytes(b.bytes)}`}
                onClick={() => (b.id === null ? onGroup(b.top) : onPick(b.id))}
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
          {scaleTicks.map((v, i) => {
            const pct = storedMb ? 100 - (v / storedMb) * 100 : 100;
            const major = i % 2 === 0;
            return (
              <span key={v}>
                <i style={{ top: `${pct}%`, width: major ? 12 : 6 }} />
                {major && (
                  <b style={{ top: `${Math.min(97, Math.max(3, pct))}%` }}>
                    {v >= 1024 ? `${Math.round(v / 1024)}G` : `${Math.round(v)}M`}
                  </b>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* How full the vault is — the job free space used to do badly
          inside the plot. One dimension is all that question ever
          needed, and here it stays legible at any utilisation. */}
      <div className="alloc">
        <div className="alloc-track">
          {map.groups.map((g) => (
            <i
              key={g.top}
              className={patternOf.get(g.top) ?? "f6"}
              style={{ width: `${(g.bytes / map.allocationBytes) * 100}%` }}
              title={`${g.top} ${fmtBytes(g.bytes)}`}
            />
          ))}
        </div>
        <div className="alloc-read">
          <span>
            {fmtBytes(map.usedBytes)} OF {fmtBytes(map.allocationBytes)}
          </span>
          <span>{fmtBytes(map.freeBytes)} FREE</span>
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
  onClose,
  onShare,
  onRevoke,
  onPin,
  onTrash,
  onOpen,
}: {
  row: ObjectRow | null;
  allocation: number;
  pending: boolean;
  onClose: () => void;
  onShare: (id: number) => void;
  onRevoke: (id: number) => void;
  onPin: (id: number, pinned: boolean) => void;
  onTrash: (id: number) => void;
  onOpen: (id: number, download: boolean) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  /* What the browser can render with nothing shipped to help it:
     images, video, audio, and PDFs. Everything else gets an honest
     "no preview" plate rather than a broken box. */
  const previewable = row
    ? row.kind === "image" || row.kind === "video" || row.kind === "audio" || row.ext === "pdf"
    : false;

  /* Previews use intent=preview so that glancing at a thumbnail does
     NOT clear the file's cold flag. */
  useEffect(() => {
    setPreview(null);
    if (!row || !previewable) return;
    let alive = true;
    fetch(`/api/objects/${row.id}/url?intent=preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => alive && j && setPreview(j.url))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [row, previewable]);

  /* Pressing play IS using the file, unlike letting a thumbnail load.
     One request, result discarded — it exists for the side effect of
     stamping lastOpenedAt, which is the only thing that clears COLD. */
  const countAsOpened = useCallback(() => {
    if (!row) return;
    void fetch(`/api/objects/${row.id}/url?intent=open`).catch(() => {});
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
      {/* Only rendered as a control below the breakpoint; on desktop the
          pane is permanent and there is nothing to close. */}
      <button className="sheetclose" onClick={onClose} aria-label="Close">
        Close
      </button>
      <h3>{row.name}</h3>
      <div className="path">{(row.folderPath ?? "INBOX").toUpperCase()}</div>

      <div className="prev brk">
        {preview && row.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" />
        ) : preview && row.ext === "pdf" ? (
          /* The browser's own PDF viewer, which is already sandboxed by
             the browser — the same mechanism every webmail relies on to
             preview attachments. An iframe sandbox attribute on top of
             it is not extra safety: with allow-same-origin it isolates
             nothing, and without it Chrome's viewer often refuses to
             render at all, which is a blank pane pretending to be a
             security measure.
             What does the work is the blob route: a fixed
             application/pdf content-type with nosniff, so a file cannot
             talk the browser into treating it as HTML.
             <object> rather than <iframe> for the fallback — a browser
             with no PDF viewer shows the child instead of nothing. */
          <object data={`${preview}#toolbar=0&navpanes=0&view=FitH`} type="application/pdf" aria-label={row.name}>
            <span className="none">NO INLINE VIEWER</span>
          </object>
        ) : preview && row.kind === "video" ? (
          /* preload="metadata" fetches the header and the duration and
             stops. Anything more would pull a gigabyte off the disk for
             a pane you may never look at. */
          <video src={preview} controls preload="metadata" playsInline onPlay={countAsOpened} />
        ) : preview && row.kind === "audio" ? (
          <audio src={preview} controls preload="metadata" onPlay={countAsOpened} />
        ) : previewable ? (
          "LOADING"
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
        {/* A file that exists is never 0.0% of anything. */}
        <span>{share(row.bytes, allocation)}</span>
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
          {fmtBytes(row.bytes)} · {share(row.bytes, allocation)} OF ALLOC
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
