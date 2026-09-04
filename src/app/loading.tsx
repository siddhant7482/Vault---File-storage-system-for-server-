/* ============================================================
   The panel, unpowered.

   Same trick as the hub's loader: render the real chassis with the
   lamps dead and every readout dashed, so when the data lands
   nothing moves. A spinner would be the wrong object — instruments
   do not spin, they warm up.

   The heights here have to match the live panel. A loader that is a
   different shape from the page it precedes causes exactly the
   layout shift it exists to prevent.
   ============================================================ */

export default function Loading() {
  return (
    <div className="z" aria-busy="true" aria-label="Reading the index">
      <div className="bar">
        {/* Present but inert. Without it the top rail is one control
            narrower than the panel it precedes, and the wordmark jumps
            sideways the moment the data lands — the exact shift this
            whole file exists to avoid. */}
        <span className="navbtn" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <div className="mark">Vault</div>
        <div className="desig">VLT-105 · STORE · —</div>
        <div className="lamps">
          <div className="lamp dead">
            <i />
            LINK
          </div>
          <div className="lamp dead">
            <i />
            SCAN
          </div>
          <div className="lamp dead">
            <i />
            INBOX —
          </div>
        </div>
      </div>

      <div className="app">
        <nav className="nav">
          <span className="cap">Volumes</span>
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="fold" key={i} style={{ opacity: 0.35 }}>
              <span className="tw" />
              <span className="sw" />
              <span className="nm">—</span>
              <span className="n">—</span>
            </div>
          ))}

          <div className="gauge brk">
            <span className="cap">Allocation</span>
            <div className="fig" style={{ color: "var(--dim-2)" }}>
              —<b>GB</b>
            </div>
            <div className="of">READING INDEX</div>
            <div className="track" />
            <div className="ticks">
              <span>0</span>
              <span>—</span>
              <span>—</span>
              <span>—</span>
            </div>
          </div>
        </nav>

        <main className="main">
          <div className="crumbs">
            <span>VAULT</span>
          </div>

          <div className="search">
            <input placeholder="Query names, volumes, tags" disabled />
            <div className="kbd">
              <b>⌘</b>
              <b>K</b>
            </div>
          </div>

          <div className="inbox clear">
            <div className="in-h">
              <span className="ttl">Inbox</span>
              <span className="note">READING</span>
            </div>
          </div>

          <div className="head">
            <h2 style={{ color: "var(--dim-2)" }}>—</h2>
            <span className="sub">— OBJ</span>
            <span className="sp" />
            <button className="tog" disabled>
              <i />
              Cold
            </button>
            <div className="seg2">
              <button aria-pressed="true">Plot</button>
              <button aria-pressed="false">Index</button>
            </div>
          </div>

          {/* Full height, empty. The plot is the tallest thing on the
              page, so this is the shift that actually matters. */}
          <div className="plot brk">
            <div className="mapwrap full" />
          </div>
          <div className="legend">
            <span className="lg">SURVEYING</span>
          </div>
        </main>

        <aside className="detail">
          <span className="cap">No selection</span>
        </aside>
      </div>
    </div>
  );
}
