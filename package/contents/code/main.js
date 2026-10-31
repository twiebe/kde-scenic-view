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
//
// Requires KWin 6.3+ (Window.maximizeMode). Tested on KWin 6.7.5.
// - Maximized windows: KWin keeps a window maximized when its geometry is changed
//   by a script, so we shrink maximized windows by the gap. Whenever KWin resets a
//   maximized window to the full work area (maximize, work area change, output
//   change), we shrink it again. Un-maximizing restores the original geometry as
//   usual, and the maximize button keeps working.
// - Scenic view is a maximized window with the larger scenic margins.

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

function inset(area, h, v) {
    // Never shrink below half the work area, whatever the configured margins.
    h = Math.min(h, Math.floor(area.width / 4));
    v = Math.min(v, Math.floor(area.height / 4));
    return { x: area.x + h, y: area.y + v, width: area.width - 2 * h, height: area.height - 2 * v };
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
    if (!tile || busy.has(k) || !eligible(w) || w.maximizeMode || w.move || w.resize) {
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
    busy.add(k);
    try {
        w.frameGeometry = target;
    } finally {
        busy.delete(k);
    }
}

// ---------------------------------------------------------------------------
// Maximized windows and scenic view

const scenic = new Set(); // keys of windows currently in scenic view
const scenicMeta = new Map(); // key -> { wasMaximized, tile }
const busy = new Set(); // reentrancy guard per window
const pendingTile = new Map(); // key -> tile to re-enter once un-maximize completed

function targetGeometry(w, area) {
    const cfg = config();
    if (scenic.has(key(w)) && w.maximizeMode === MAX_FULL) {
        return inset(area, cfg.scenicH, cfg.scenicV);
    }
    const g = w.frameGeometry;
    const r = { x: g.x, y: g.y, width: g.width, height: g.height };
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

// Safety net against clients that refuse the smaller size: at most a few
// geometry changes per window and second.
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

// force=false: only act if the window reaches into the margin (see exceeds()).
// force=true:  always move to the target (config change, scenic toggle).
function applyMaximizeGap(w, force) {
    const k = key(w);
    if (busy.has(k) || !eligible(w) || !w.maximizeMode) {
        return;
    }
    const area = workspace.clientArea(KWin.MaximizeArea, w);
    const g = w.frameGeometry;
    const target = targetGeometry(w, area);
    if (sameRect(g, target) || (!force && !exceeds(w, g, target)) || rateLimited(k)) {
        return;
    }
    busy.add(k);
    try {
        w.frameGeometry = target;
    } finally {
        busy.delete(k);
    }
}

function leaveScenic(k) {
    scenic.delete(k);
    scenicMeta.delete(k);
}

function toggleScenic() {
    const w = workspace.activeWindow;
    if (!eligible(w) || !w.maximizable) {
        return;
    }
    const k = key(w);

    if (scenic.has(k)) {
        const meta = scenicMeta.get(k) || {};
        leaveScenic(k);
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

    scenic.add(k);
    scenicMeta.set(k, { wasMaximized: w.maximizeMode === MAX_FULL, tile: w.tile });
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
    w.maximizedChanged.connect(() => {
        const k = key(w);
        // Leaving full maximize (e.g. user un-maximized or dragged the window)
        // ends scenic view.
        if (w.maximizeMode !== MAX_FULL) {
            leaveScenic(k);
        }
        const tile = pendingTile.get(k);
        if (tile && w.maximizeMode === 0) {
            pendingTile.delete(k);
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
        applyMaximizeGap(w, false);
    });
    w.frameGeometryChanged.connect(() => {
        applyMaximizeGap(w, false);
        applyTileEdges(w);
    });
    w.interactiveMoveResizeFinished.connect(() => applyTileEdges(w));
    w.tileChanged.connect(() => {
        if (w.tile) {
            leaveScenic(key(w));
        }
        applyTileGap(w);
    });
    applyTileGap(w);
    applyMaximizeGap(w, true); // script (re)load: bring maximized windows to current settings
}

function reapplyAll() {
    for (const w of workspace.windowList()) {
        if (eligible(w)) {
            applyTileGap(w);
            applyMaximizeGap(w, true);
        }
    }
}

workspace.windowList().forEach(setup);
workspace.windowAdded.connect(setup);
workspace.windowRemoved.connect((w) => {
    const k = key(w);
    leaveScenic(k);
    busy.delete(k);
    pendingTile.delete(k);
    recent.delete(k);
    lastTileTarget.delete(k);
});
options.configChanged.connect(reapplyAll);

registerShortcut("ScenicViewToggle", "Toggle Scenic View",
                 "Meta+Alt+S", toggleScenic);
