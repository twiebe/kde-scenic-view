// SPDX-License-Identifier: MIT
//
// Scenic View - KWin script (Plasma 6)
//
// 1. Gaps: tiled windows (quick tiling, optionally custom tiles) and maximized
//    windows keep a configurable gap to the edges of the work area (measured to
//    panels, not to the screen edge; separate values for left/right and
//    top/bottom) and a separately configurable gap between each other.
// 2. Scenic view: a shortcut toggles the active window into a "maximized with
//    larger margins" state, so more of the wallpaper stays visible.
//
// How:
// - Tiles: KWin tiles have a `padding` property (half padding between tiles,
//   full padding at the edges). Quick tiles are created with padding 0. We set it
//   to the inner gap on the root tile of whatever tile a window is in, so KWin
//   handles the gaps between windows. Sides of a tiled window that touch the edge
//   of the work area are then moved to the outer gap by the script. KWin keeps a
//   window in its tile when a script changes its geometry; whenever KWin re-applies
//   the tile geometry (tile resize, work area change), we adjust the edges again.
// - Maximized windows, two modes (setting "KeepDecorationWhenMaximized"):
//   a) Keep decoration (default): KWin and Breeze draw maximized windows without
//      shadow and rounded corners. So when a window is about to be maximized, the
//      script remembers its geometry, takes the maximize back right away (before
//      the client sees it, via a zero timer) and resizes the window to the gapped
//      area instead. It stays a normal window - with shadow and rounded corners.
//      The script tracks this "pseudo-maximized" state itself: maximizing it again
//      (button, double-click, shortcut) restores the remembered geometry.
//   b) Real maximize: KWin keeps a window maximized when a script changes its
//      geometry, so we shrink maximized windows by the gap. Whenever KWin resets a
//      maximized window to the full work area, we shrink it again.
//   Partially maximized windows (vertically/horizontally only) always use b).
// - Scenic view is the same as a maximized window, with the scenic margins.
//
// Requires KWin 6.3+ (Window.maximizeMode). Tested on KWin 6.7.5.

"use strict";

const MAX_VERTICAL = 1;
const MAX_HORIZONTAL = 2;
const MAX_FULL = 3;

// ---------------------------------------------------------------------------
// Configuration. Note: KWin only re-reads script settings when the script is
// reloaded (disable, Apply, enable, Apply in System Settings).

function cfgInt(key, def) {
    const v = Number(readConfig(key, def));
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : def;
}

function cfgBool(key, def) {
    const v = readConfig(key, def);
    return v === true || v === "true";
}

function config() {
    return {
        outerH: cfgInt("OuterGapHorizontal", 32), // left/right edges
        outerV: cfgInt("OuterGapVertical", 32), // top/bottom edges
        inner: cfgInt("InnerGap", 16),
        scenicH: cfgInt("ScenicGapHorizontal", 80),
        scenicV: cfgInt("ScenicGapVertical", 80),
        customTiles: cfgBool("ApplyToCustomTiles", true),
        keepDecoration: cfgBool("KeepDecorationWhenMaximized", true),
    };
}

// ---------------------------------------------------------------------------
// Helpers

const near = (a, b) => Math.abs(a - b) < 1;

function key(w) {
    return String(w.internalId);
}

function eligible(w) {
    return w && w.normalWindow && w.resizeable && w.moveable && !w.fullScreen;
}

function rectOf(g) {
    return { x: g.x, y: g.y, width: g.width, height: g.height };
}

function sameRect(a, b) {
    return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

// g is what a client with size increments makes of the requested rect r:
// same position, size rounded down by less than one increment.
function roundedFrom(g, r) {
    const maxStep = 48;
    return near(g.x, r.x) && near(g.y, r.y) &&
        g.width <= r.width + 0.5 && g.width > r.width - maxStep &&
        g.height <= r.height + 0.5 && g.height > r.height - maxStep;
}

function workArea(w) {
    return workspace.clientArea(KWin.MaximizeArea, w);
}

function inset(area, h, v) {
    // Never shrink below half the work area, whatever the configured margins.
    h = Math.min(h, Math.floor(area.width / 4));
    v = Math.min(v, Math.floor(area.height / 4));
    return { x: area.x + h, y: area.y + v, width: area.width - 2 * h, height: area.height - 2 * v };
}

function gapRect(area, cfg) {
    return inset(area, cfg.outerH, cfg.outerV);
}

function scenicRect(area, cfg) {
    return inset(area, cfg.scenicH, cfg.scenicV);
}

// Safety net against clients that refuse a size: at most a few geometry changes
// per window and second.
const recent = new Map(); // key -> timestamps of recent applications
function rateLimited(k) {
    const now = Date.now();
    const list = (recent.get(k) || []).filter((t) => now - t < 1000);
    if (list.length >= 4) {
        recent.set(k, list);
        return true;
    }
    list.push(now);
    recent.set(k, list);
    return false;
}

const busy = new Set(); // keys of windows we are changing right now

function own(w, fn) {
    const k = key(w);
    busy.add(k);
    try {
        fn();
    } finally {
        busy.delete(k);
    }
}

function setGeometry(w, r) {
    own(w, () => {
        w.frameGeometry = r;
    });
}

// Run fn after KWin has finished the current operation (zero timer).
const timers = new Set();
function later(fn) {
    const t = new QTimer();
    t.singleShot = true;
    t.interval = 0;
    timers.add(t);
    t.timeout.connect(() => {
        timers.delete(t);
        try {
            fn();
        } catch (e) {
            console.log("scenic-view: " + e);
        }
    });
    t.start();
}

function retile(w, tile) {
    try {
        if (typeof tile.manage === "function") {
            tile.manage(w); // KWin 6.4+
        } else {
            w.tile = tile; // KWin 6.3
        }
    } catch (e) {
        console.log("scenic-view: could not re-tile window: " + e);
    }
}

function untile(w) {
    const tile = w.tile;
    if (!tile) {
        return;
    }
    try {
        if (typeof tile.unmanage === "function") {
            tile.unmanage(w); // KWin 6.4+
        } else {
            w.tile = null; // KWin 6.3
        }
    } catch (e) {
        console.log("scenic-view: could not untile window: " + e);
    }
}

// ---------------------------------------------------------------------------
// Tiles

function rootTile(tile) {
    let t = tile;
    while (t && t.parent) {
        t = t.parent;
    }
    return t;
}

const lastTileTarget = new Map(); // key -> last geometry we set for a tiled window

function tileManaged(tile, cfg) {
    const isQuickTile = String(rootTile(tile)).indexOf("QuickRootTile") !== -1;
    return isQuickTile || cfg.customTiles;
}

// Geometry of a tiled window: half the inner gap towards neighboring tiles (as
// KWin does with padding), the outer gap where the tile touches the work area edge.
function tileTarget(tile, cfg) {
    const rel = tile.relativeGeometry;
    const abs = tile.absoluteGeometry; // tile area within the work area (panels excluded)
    const eps = 1e-6;
    const half = cfg.inner / 2;
    const l = rel.x > eps ? half : cfg.outerH;
    const t = rel.y > eps ? half : cfg.outerV;
    const r = rel.x + rel.width < 1 - eps ? half : cfg.outerH;
    const b = rel.y + rel.height < 1 - eps ? half : cfg.outerV;
    return { x: abs.x + l, y: abs.y + t, width: abs.width - l - r, height: abs.height - t - b };
}

function applyTileGap(w) {
    const tile = w.tile;
    if (!tile) {
        return;
    }
    const cfg = config();
    if (!tileManaged(tile, cfg)) {
        return;
    }
    const root = rootTile(tile);
    if (root.padding !== cfg.inner) {
        root.padding = cfg.inner; // propagates to all child tiles and their windows
    }
    applyTileEdges(w);
}

function applyTileEdges(w) {
    const k = key(w);
    const tile = w.tile;
    if (!tile || busy.has(k) || pseudo.has(k) || !eligible(w) || w.maximizeMode || w.move || w.resize) {
        return;
    }
    const cfg = config();
    if (!tileManaged(tile, cfg)) {
        return;
    }
    const g = w.frameGeometry;
    const target = tileTarget(tile, cfg);
    if (sameRect(g, target)) {
        return;
    }
    // A client with size increments (terminals) ends up slightly smaller than
    // requested, at the requested position. Accept that if we requested exactly
    // this target before - unless KWin has just re-applied its own tile geometry.
    const p = tile.padding;
    const kwinGeometry = tileTarget(tile, { inner: p, outerH: p, outerV: p });
    const last = lastTileTarget.get(k);
    if (last && sameRect(last, target) && roundedFrom(g, target) && !sameRect(g, kwinGeometry)) {
        return;
    }
    if (rateLimited(k)) {
        return;
    }
    lastTileTarget.set(k, target);
    setGeometry(w, target);
}

// ---------------------------------------------------------------------------
// Mode a) pseudo-maximize: normal windows sized like a gapped maximize

// key -> { kind: "max" | "scenic", restore: rect, tile, scenicFromMax: bool, area: rect }
const pseudo = new Map();
const movingPseudo = new Set(); // pseudo windows the user started to move/resize

function pseudoTarget(w, p, cfg) {
    const area = workArea(w);
    return p.kind === "scenic" ? scenicRect(area, cfg) : gapRect(area, cfg);
}

function fitPseudo(w) {
    const k = key(w);
    const p = pseudo.get(k);
    if (!p || busy.has(k) || w.move || w.resize) {
        return;
    }
    p.area = rectOf(workArea(w));
    const target = pseudoTarget(w, p, config());
    const g = w.frameGeometry;
    if (sameRect(g, target) || roundedFrom(g, target) || rateLimited(k)) {
        return;
    }
    setGeometry(w, target);
}

function enterPseudo(w, kind, restore, tile) {
    const k = key(w);
    pseudo.set(k, { kind: kind, restore: restore, tile: tile, scenicFromMax: false, area: null });
    own(w, () => {
        if (w.tile) {
            untile(w);
        }
        // Always: maximizeMode only reflects what the client has acknowledged, a
        // maximize that was just requested isn't visible there yet. A no-op for
        // KWin if nothing is requested.
        w.setMaximize(false, false);
    });
    fitPseudo(w);
    ensurePolling();
}

function leavePseudo(w) {
    const k = key(w);
    const p = pseudo.get(k);
    pseudo.delete(k);
    if (!p) {
        return;
    }
    if (p.tile) {
        own(w, () => retile(w, p.tile));
        applyTileGap(w);
    } else if (p.restore) {
        setGeometry(w, p.restore);
    }
}

// Default "restore" geometry for windows that were already maximized when we
// first saw them (we don't know their previous geometry).
function defaultRestore(w) {
    const a = workArea(w);
    const width = Math.round(a.width * 0.6);
    const height = Math.round(a.height * 0.7);
    return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width: width, height: height };
}

function onMaximizeAboutToChange(w, mode) {
    const k = key(w);
    if (busy.has(k) || !eligible(w) || mode !== MAX_FULL || !config().keepDecoration) {
        return;
    }
    const p = pseudo.get(k);
    if (p && !w.move) {
        // Maximize requested on a pseudo-maximized window (its maximize button shows
        // "not maximized"): the user wants it back, so this acts as un-maximize.
        later(() => {
            own(w, () => w.setMaximize(false, false));
            leavePseudo(w);
        });
        return;
    }
    // Remember the geometry before maximizing (still current at this point),
    // or keep the original one if the window was pseudo-maximized and is being
    // maximized again by dragging it to the top edge.
    const restore = p ? p.restore : rectOf(w.frameGeometry);
    const tile = p ? p.tile : w.tile;
    later(() => enterPseudo(w, "max", restore, tile));
}

// Panels can change the work area without any signal; check pseudo windows
// every two seconds while there are any.
let pollTimer = null;
function ensurePolling() {
    if (pollTimer || pseudo.size === 0) {
        return;
    }
    pollTimer = new QTimer();
    pollTimer.interval = 2000;
    pollTimer.singleShot = false;
    pollTimer.timeout.connect(() => {
        if (pseudo.size === 0) {
            pollTimer.stop();
            pollTimer = null;
            return;
        }
        for (const w of workspace.windowList()) {
            const p = pseudo.get(key(w));
            if (p && (!p.area || !sameRect(p.area, workArea(w)))) {
                fitPseudo(w);
            }
        }
    });
    pollTimer.start();
}

// ---------------------------------------------------------------------------
// Mode b) real maximize, shrunk by the gaps (also used for partial maximize)

const realScenic = new Set(); // keys of really maximized windows in scenic view
const realScenicMeta = new Map(); // key -> { wasMaximized, tile }
const pendingTile = new Map(); // key -> tile to re-enter once un-maximize completed

function realTarget(w, area) {
    const cfg = config();
    if (realScenic.has(key(w)) && w.maximizeMode === MAX_FULL) {
        return scenicRect(area, cfg);
    }
    const r = rectOf(w.frameGeometry);
    if (w.maximizeMode & MAX_HORIZONTAL) {
        r.x = area.x + cfg.outerH;
        r.width = area.width - 2 * cfg.outerH;
    }
    if (w.maximizeMode & MAX_VERTICAL) {
        r.y = area.y + cfg.outerV;
        r.height = area.height - 2 * cfg.outerV;
    }
    return r;
}

// Does the window reach into the margin on one of its maximized axes? That is the
// case after KWin (re)sets the full work area (maximize, work area or output
// change). Clients with size increments (terminals) may end up a bit smaller
// than requested; they don't reach into the margin, so we leave them alone.
function exceeds(w, g, t) {
    const h = (w.maximizeMode & MAX_HORIZONTAL) &&
        (g.x < t.x - 0.5 || g.x + g.width > t.x + t.width + 0.5);
    const v = (w.maximizeMode & MAX_VERTICAL) &&
        (g.y < t.y - 0.5 || g.y + g.height > t.y + t.height + 0.5);
    return h || v;
}

// force=false: only act if the window reaches into the margin (see exceeds()).
// force=true:  always move to the target (script load, scenic toggle).
function applyMaximizeGap(w, force) {
    const k = key(w);
    if (busy.has(k) || pseudo.has(k) || !eligible(w) || !w.maximizeMode) {
        return;
    }
    if (w.maximizeMode === MAX_FULL && config().keepDecoration) {
        return; // mode a) takes care of full maximize
    }
    const area = workArea(w);
    const g = w.frameGeometry;
    const target = realTarget(w, area);
    if (sameRect(g, target) || (!force && !exceeds(w, g, target)) || rateLimited(k)) {
        return;
    }
    setGeometry(w, target);
}

function leaveRealScenic(k) {
    realScenic.delete(k);
    realScenicMeta.delete(k);
}

// ---------------------------------------------------------------------------
// Scenic view shortcut

function toggleScenic() {
    const w = workspace.activeWindow;
    if (!eligible(w) || !w.maximizable) {
        return;
    }
    const k = key(w);
    const cfg = config();

    if (cfg.keepDecoration) {
        const p = pseudo.get(k);
        if (p && p.kind === "scenic") {
            if (p.scenicFromMax) {
                p.kind = "max"; // back to a gapped maximize
                p.scenicFromMax = false;
                fitPseudo(w);
            } else {
                leavePseudo(w); // back to the original geometry or tile
            }
        } else if (p) {
            p.kind = "scenic";
            p.scenicFromMax = true;
            fitPseudo(w);
        } else {
            enterPseudo(w, "scenic", rectOf(w.frameGeometry), w.tile);
        }
        return;
    }

    if (realScenic.has(k)) {
        const meta = realScenicMeta.get(k) || {};
        leaveRealScenic(k);
        if (meta.wasMaximized) {
            applyMaximizeGap(w, true); // back to a regular gapped maximize
        } else {
            // KWin restores the original geometry. Un-maximizing is asynchronous
            // (the client has to acknowledge), so re-tiling waits for it.
            if (meta.tile) {
                pendingTile.set(k, meta.tile);
            }
            w.setMaximize(false, false);
        }
        return;
    }
    realScenic.add(k);
    realScenicMeta.set(k, { wasMaximized: w.maximizeMode === MAX_FULL, tile: w.tile });
    if (w.maximizeMode === MAX_FULL) {
        applyMaximizeGap(w, true);
    } else {
        // Geometry follows asynchronously; frameGeometryChanged/maximizedChanged
        // then apply the scenic margins.
        w.setMaximize(true, true);
    }
}

// ---------------------------------------------------------------------------
// Wiring

function setup(w) {
    if (!w || !w.normalWindow) {
        return;
    }
    w.maximizedAboutToChange.connect((mode) => onMaximizeAboutToChange(w, mode));
    w.maximizedChanged.connect(() => {
        const k = key(w);
        // Leaving full maximize (e.g. user un-maximized or dragged the window)
        // ends real scenic view.
        if (w.maximizeMode !== MAX_FULL) {
            leaveRealScenic(k);
        }
        const tile = pendingTile.get(k);
        if (tile && w.maximizeMode === 0) {
            pendingTile.delete(k);
            own(w, () => retile(w, tile));
        }
        applyMaximizeGap(w, false);
    });
    w.frameGeometryChanged.connect(() => {
        const k = key(w);
        if (busy.has(k)) {
            return;
        }
        if (pseudo.has(k)) {
            fitPseudo(w); // e.g. KWin moved it to keep it inside a changed work area
        }
        applyMaximizeGap(w, false);
        applyTileEdges(w);
    });
    w.interactiveMoveResizeStarted.connect(() => {
        if (pseudo.has(key(w))) {
            movingPseudo.add(key(w));
        }
    });
    w.interactiveMoveResizeFinished.connect(() => {
        const k = key(w);
        if (movingPseudo.delete(k)) {
            // The user moved or resized a pseudo-maximized window: it's a normal
            // window now. (Dropping it on the top edge maximizes it again through
            // onMaximizeAboutToChange.)
            pseudo.delete(k);
        }
        applyTileEdges(w);
    });
    w.tileChanged.connect(() => {
        const k = key(w);
        if (w.tile && !busy.has(k)) {
            leaveRealScenic(k);
            pseudo.delete(k); // the user tiled the window
        }
        applyTileGap(w);
    });

    // Script (re)load or new window: bring it to the current settings.
    applyTileGap(w);
    if (eligible(w) && w.maximizeMode === MAX_FULL && config().keepDecoration) {
        enterPseudo(w, "max", defaultRestore(w), null);
    } else {
        applyMaximizeGap(w, true);
    }
}

function reapplyAll() {
    for (const w of workspace.windowList()) {
        if (eligible(w)) {
            applyTileGap(w);
            applyMaximizeGap(w, true);
            fitPseudo(w);
        }
    }
}

workspace.windowList().forEach(setup);
workspace.windowAdded.connect(setup);
workspace.windowRemoved.connect((w) => {
    const k = key(w);
    leaveRealScenic(k);
    pseudo.delete(k);
    movingPseudo.delete(k);
    busy.delete(k);
    pendingTile.delete(k);
    recent.delete(k);
    lastTileTarget.delete(k);
});
workspace.screensChanged.connect(reapplyAll);
workspace.virtualScreenGeometryChanged.connect(reapplyAll);
options.configChanged.connect(reapplyAll);

registerShortcut("ScenicViewToggle", "Toggle Scenic View",
                 "Meta+Alt+S", toggleScenic);
