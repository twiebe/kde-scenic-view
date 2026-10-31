// SPDX-License-Identifier: MIT
// Usage: node tests/kwin-mock.test.js package/contents/code/main.js
// Mock of the KWin 6.7 scripting API, modeled on the behavior read from the source:
// - maximize is async (client ack), KWin sets the full MaximizeArea geometry
// - scripts may resize a maximized window without changing its maximize mode
// - un-maximize restores the geometry saved at maximize time
// - Tile.padding setter propagates and resizes managed windows
"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

function signal() {
    const fns = [];
    const s = (...a) => fns.slice().forEach((f) => f(...a));
    s.connect = (f) => fns.push(f);
    return s;
}

let AREA = { x: 0, y: 40, width: 1440, height: 920 }; // panel at top: 40px
const queue = [];
const flush = () => { while (queue.length) queue.shift()(); };

class Tile {
    // KWin: a child tile inherits the parent's padding
    constructor(name, parent, rel) { this.name = name; this.parent = parent || null; this._padding = parent ? parent._padding : 0; this.rel = rel; this.windows = []; this.children = []; if (parent) parent.children.push(this); }
    toString() { return `KWin::${this.name}(0x1)`; }
    get padding() { return this._padding; }
    set padding(p) { this._padding = p; this.children.forEach((c) => { c.padding = p; }); this.windows.forEach((w) => w._setGeom(this.windowGeometry())); }
    windowGeometry() {
        const r = this.rel, p = this._padding;
        const l = r.x > 0 ? p / 2 : p, t = r.y > 0 ? p / 2 : p, rr = r.x + r.w < 1 ? p / 2 : p, b = r.y + r.h < 1 ? p / 2 : p;
        const x = AREA.x + r.x * AREA.width, y = AREA.y + r.y * AREA.height;
        return { x: x + l, y: y + t, width: r.w * AREA.width - l - rr, height: r.h * AREA.height - t - b };
    }
    get relativeGeometry() { return { x: this.rel.x, y: this.rel.y, width: this.rel.w, height: this.rel.h }; }
    get absoluteGeometry() { return { x: AREA.x + this.rel.x * AREA.width, y: AREA.y + this.rel.y * AREA.height, width: this.rel.w * AREA.width, height: this.rel.h * AREA.height }; }
    manage(w) { w._tileTo(this); return true; }
}

let nextId = 1;
class Win {
    constructor(geom, opts = {}) {
        this.internalId = `{uuid-${nextId++}}`;
        this.normalWindow = true; this.resizeable = true; this.moveable = true; this.fullScreen = false; this.maximizable = true;
        this.maximizeMode = 0; this._geom = { ...geom }; this._restore = null; this._tile = null;
        this.sizeIncrement = opts.sizeIncrement || 0; // e.g. terminal rounding
        this.minWidth = opts.minWidth || 0;
        this.maximizedChanged = signal(); this.frameGeometryChanged = signal(); this.tileChanged = signal();
        this.interactiveMoveResizeFinished = signal(); this.move = false; this.resize = false;
        this.sets = 0;
    }
    get tile() { return this._tile; }
    set tile(t) { if (t) this._tileTo(t); else if (this._tile) this._untile(); } // KWin 6.3 API
    get frameGeometry() { return { ...this._geom }; }
    set frameGeometry(r) { this.sets++; assert(this.sets < 50, "geometry set loop"); this._setGeom(r); }
    _setGeom(r) {
        let g = { ...r };
        if (this.sizeIncrement) { g.width = Math.floor(g.width / this.sizeIncrement) * this.sizeIncrement; g.height = Math.floor(g.height / this.sizeIncrement) * this.sizeIncrement; }
        if (this.minWidth && g.width < this.minWidth) { g.width = this.minWidth; }
        const old = this._geom; this._geom = g; this.frameGeometryChanged(old);
    }
    setMaximize(v, h) {
        const mode = (v ? 1 : 0) | (h ? 2 : 0);
        if (mode === this.maximizeMode) return;
        if (mode && !this.maximizeMode) { this._restore = this._tile ? this._restore : { ...this._geom }; if (this._tile) { this._untile(); } }
        queue.push(() => {
            if (mode) { const g = { ...this._geom }; if (mode & 2) { g.x = AREA.x; g.width = AREA.width; } if (mode & 1) { g.y = AREA.y; g.height = AREA.height; } this._setGeom(g); } else this._setGeom(this._restore);
            this.maximizeMode = mode; this.maximizedChanged();
        });
    }
    _tileTo(tile) { this._restore = { ...this._geom }; this.maximizeMode = 0; this._tile = tile; tile.windows.push(this); this.tileChanged(tile); this._setGeom(tile.windowGeometry()); }
    _untile() { const t = this._tile; t.windows.splice(t.windows.indexOf(this), 1); this._tile = null; this.tileChanged(null); }
    workareaChanged() { if (this.maximizeMode) { const g = { ...this._geom }; if (this.maximizeMode & 2) { g.x = AREA.x; g.width = AREA.width; } if (this.maximizeMode & 1) { g.y = AREA.y; g.height = AREA.height; } this._setGeom(g); } else if (this._tile) { this._setGeom(this._tile.windowGeometry()); } }
}

// --- KWin globals
let config = {};
let useShippedDefaults = false;
const BASE = { OuterGapHorizontal: 12, OuterGapVertical: 12, InnerGap: 12, ScenicGapHorizontal: 120, ScenicGapVertical: 80 };
const shortcuts = {};
const windows = [];
const workspace = {
    activeWindow: null,
    windowList: () => windows.slice(),
    windowAdded: signal(), windowRemoved: signal(),
    clientArea: () => ({ ...AREA }),
};
const options = { configChanged: signal() };
const ctx = vm.createContext({
    // Tests run against a fixed baseline; the "shipped defaults" test bypasses it.
    readConfig: (k, d) => (useShippedDefaults ? d : k in config ? config[k] : k in BASE ? BASE[k] : d),
    registerShortcut: (id, text, keys, cb) => { shortcuts[id] = cb; },
    KWin: { MaximizeArea: 2 }, workspace, options, console,
});

function addWindow(geom, opts) { const w = new Win(geom, opts); windows.push(w); workspace.windowAdded(w); return w; }
const R = (g) => `${g.x},${g.y} ${g.width}x${g.height}`;
let failed = 0;
function test(name, fn) { try { fn(); console.log("PASS", name); } catch (e) { failed++; console.log("FAIL", name, "-", e.message); } }

// pre-existing window before script start
const pre = new Win({ x: 100, y: 100, width: 800, height: 600 }); windows.push(pre);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), ctx, { filename: "main.js" });
const toggle = shortcuts.ScenicViewToggle;
assert(toggle, "shortcut registered");

test("maximize -> regular gap to work area (incl. panel)", () => {
    const w = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    w.setMaximize(true, true); flush();
    assert.strictEqual(R(w.frameGeometry), "12,52 1416x896");
    assert.strictEqual(w.maximizeMode, 3);
});

test("pre-existing window is handled too", () => {
    pre.setMaximize(true, true); flush();
    assert.strictEqual(R(pre.frameGeometry), "12,52 1416x896");
});

test("work area change -> KWin resets to full area -> gap re-applied", () => {
    const w = addWindow({ x: 0, y: 0, width: 500, height: 500 });
    w.setMaximize(true, true); flush();
    AREA = { x: 0, y: 0, width: 1440, height: 960 }; // panel removed
    w.workareaChanged();
    assert.strictEqual(R(w.frameGeometry), "12,12 1416x936");
    AREA = { x: 0, y: 40, width: 1440, height: 920 };
    w.workareaChanged();
});

test("vertical-only maximize -> gap only vertically", () => {
    const w = addWindow({ x: 200, y: 300, width: 600, height: 400 });
    w.setMaximize(true, false); flush();
    assert.strictEqual(R(w.frameGeometry), "200,52 600x896");
});

test("un-maximize restores original geometry", () => {
    const w = addWindow({ x: 100, y: 120, width: 640, height: 480 });
    w.setMaximize(true, true); flush(); w.setMaximize(false, false); flush();
    assert.strictEqual(R(w.frameGeometry), "100,120 640x480");
});

test("client with size increments -> no fight/loop", () => {
    const w = addWindow({ x: 10, y: 60, width: 400, height: 300 }, { sizeIncrement: 7 });
    w.setMaximize(true, true); flush();
    assert(w.sets <= 2, `sets=${w.sets}`);
    assert.strictEqual(w.frameGeometry.x, 12);
});

test("scenic on maximized window, toggle back to regular gap", () => {
    const w = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    w.setMaximize(true, true); flush();
    workspace.activeWindow = w; toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "120,120 1200x760");
    assert.strictEqual(w.maximizeMode, 3);
    toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "12,52 1416x896");
});

test("scenic survives work area change", () => {
    const w = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    workspace.activeWindow = w; toggle(); flush();
    w.workareaChanged();
    assert.strictEqual(R(w.frameGeometry), "120,120 1200x760");
    toggle(); flush();
});

test("scenic on floating window, toggle back restores original", () => {
    const w = addWindow({ x: 300, y: 200, width: 700, height: 500 });
    workspace.activeWindow = w; toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "120,120 1200x760");
    toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "300,200 700x500");
    assert.strictEqual(w.maximizeMode, 0);
});

test("un-maximize while scenic ends scenic; next maximize is regular", () => {
    const w = addWindow({ x: 300, y: 200, width: 700, height: 500 });
    workspace.activeWindow = w; toggle(); flush();
    w.setMaximize(false, false); flush();
    assert.strictEqual(R(w.frameGeometry), "300,200 700x500");
    w.setMaximize(true, true); flush();
    assert.strictEqual(R(w.frameGeometry), "12,52 1416x896");
});

test("quick tile -> root padding = gap, halves have gap between", () => {
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const right = new Tile("Tile", root, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    const b = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(a); right.manage(b);
    assert.strictEqual(root.padding, 12);
    assert.strictEqual(R(a.frameGeometry), "12,52 702x896");
    assert.strictEqual(R(b.frameGeometry), "726,52 702x896");
    assert.strictEqual(b.frameGeometry.x - (a.frameGeometry.x + a.frameGeometry.width), 12);
});

test("custom tiles respected when ApplyToCustomTiles=false", () => {
    config = { ApplyToCustomTiles: "false" };
    const root = new Tile("RootTile", null, { x: 0, y: 0, w: 1, h: 1 }); root._padding = 4;
    const t = new Tile("CustomTile", root, { x: 0, y: 0, w: 1, h: 1 }); t._padding = 4;
    const w = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    t.manage(w);
    assert.strictEqual(root.padding, 4);
    config = {};
});

test("scenic on a tiled window re-tiles on toggle back", () => {
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const w = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(w);
    workspace.activeWindow = w; toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "120,120 1200x760");
    toggle(); flush();
    assert.strictEqual(w.tile, left);
    assert.strictEqual(R(w.frameGeometry), "12,52 702x896");
});

test("config change re-applies new gap to maximized windows", () => {
    const w = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    w.setMaximize(true, true); flush();
    config = { OuterGapHorizontal: 20, OuterGapVertical: 20 };
    options.configChanged();
    assert.strictEqual(R(w.frameGeometry), "20,60 1400x880");
    config = {};
    options.configChanged();
});

test("ineligible windows untouched (fullscreen, non-normal)", () => {
    const w = addWindow({ x: 0, y: 40, width: 1440, height: 920 });
    w.fullScreen = true; w.maximizeMode = 3; w.frameGeometryChanged();
    assert.strictEqual(R(w.frameGeometry), "0,40 1440x920");
});

test("huge scenic margins are clamped", () => {
    config = { ScenicGapHorizontal: 5000, ScenicGapVertical: 5000 };
    const w = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    workspace.activeWindow = w; toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "360,270 720x460");
    config = {};
});

test("client refusing the smaller size -> bounded retries, no loop", () => {
    const w = addWindow({ x: 0, y: 40, width: 800, height: 600 }, { minWidth: 1440 });
    w.setMaximize(true, true); flush();
    for (let i = 0; i < 20; i++) w.workareaChanged();
    assert(w.sets <= 4, `sets=${w.sets}`);
});

test("separate gaps: edge 20, between tiles 8", () => {
    config = { OuterGapHorizontal: 20, OuterGapVertical: 20, InnerGap: 8 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const right = new Tile("Tile", root, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    const b = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(a); right.manage(b);
    assert.strictEqual(root.padding, 8);
    assert.strictEqual(R(a.frameGeometry), "20,60 696x880");
    assert.strictEqual(R(b.frameGeometry), "724,60 696x880");
    assert.strictEqual(b.frameGeometry.x - (a.frameGeometry.x + a.frameGeometry.width), 8);
    // quarter tile: inner edges right/bottom, outer edges left/top
    const q = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 0.5 });
    const c = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    q.manage(c);
    assert.strictEqual(R(c.frameGeometry), "20,60 696x436");
    // maximize uses the edge gap
    const m = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    m.setMaximize(true, true); flush();
    assert.strictEqual(R(m.frameGeometry), "20,60 1400x880");
    config = {};
});

test("separate gaps survive KWin re-applying tile geometry (work area change)", () => {
    config = { OuterGapHorizontal: 20, OuterGapVertical: 20, InnerGap: 8 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(a);
    AREA = { x: 0, y: 0, width: 1440, height: 960 };
    a.workareaChanged();
    assert.strictEqual(R(a.frameGeometry), "20,20 696x920");
    AREA = { x: 0, y: 40, width: 1440, height: 920 };
    a.workareaChanged();
    assert.strictEqual(R(a.frameGeometry), "20,60 696x880");
    config = {};
});

test("tiled window with size increments: no repeated fighting", () => {
    config = { OuterGapHorizontal: 20, OuterGapVertical: 20, InnerGap: 8 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 }, { sizeIncrement: 7 });
    left.manage(a);
    const sets = a.sets;
    for (let i = 0; i < 5; i++) a.frameGeometryChanged(); // unrelated geometry notifications
    assert.strictEqual(a.sets, sets, `extra sets: ${a.sets - sets}`);
    assert.strictEqual(a.frameGeometry.x, 20);
    config = {};
});

test("no adjustment during interactive resize, applied when finished", () => {
    config = { OuterGapHorizontal: 20, OuterGapVertical: 20, InnerGap: 8 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(a);
    a.resize = true;
    left.rel = { x: 0, y: 0, w: 0.6, h: 1 }; // user drags the tile border
    a._setGeom(left.windowGeometry());
    assert.notStrictEqual(a.frameGeometry.x, 20);
    a.resize = false; a.interactiveMoveResizeFinished();
    assert.strictEqual(R(a.frameGeometry), "20,60 840x880");
    config = {};
});

test("edge gap smaller than inner gap (edge 8, between 20)", () => {
    config = { OuterGapHorizontal: 8, OuterGapVertical: 8, InnerGap: 20 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const right = new Tile("Tile", root, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    const b = addWindow({ x: 0, y: 0, width: 300, height: 300 }, { sizeIncrement: 1 });
    left.manage(a); right.manage(b);
    assert.strictEqual(R(a.frameGeometry), "8,48 702x904");
    assert.strictEqual(R(b.frameGeometry), "730,48 702x904");
    assert.strictEqual(b.frameGeometry.x - (a.frameGeometry.x + a.frameGeometry.width), 20);
    b.workareaChanged(); // KWin re-applies its own geometry: right edge back at 20
    assert.strictEqual(R(b.frameGeometry), "730,48 702x904");
    config = {};
});

test("edge gaps left/right 30, top/bottom 10, between 8", () => {
    config = { OuterGapHorizontal: 30, OuterGapVertical: 10, InnerGap: 8 };
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const tl = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 0.5 });
    const br = new Tile("Tile", root, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    const b = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    tl.manage(a); br.manage(b);
    assert.strictEqual(R(a.frameGeometry), "30,50 686x446");   // left 30, top 10, right/bottom 4
    assert.strictEqual(R(b.frameGeometry), "724,504 686x446"); // left/top 4, right 30, bottom 10
    const m = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    m.setMaximize(true, true); flush();
    assert.strictEqual(R(m.frameGeometry), "30,50 1380x900");
    config = {};
});

test("KWin 6.3: re-tile via window.tile when Tile.manage() is missing", () => {
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const w = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    w.tile = left; // KWin 6.3 way of tiling
    left.manage = undefined; // not invokable in 6.3
    workspace.activeWindow = w; toggle(); flush();
    assert.strictEqual(R(w.frameGeometry), "120,120 1200x760");
    toggle(); flush();
    assert.strictEqual(w.tile, left);
    assert.strictEqual(R(w.frameGeometry), "12,52 702x896");
});

test("script (re)load applies a smaller gap to already maximized windows", () => {
    // simulate: window maximized with old 20px gap, script reloaded with 12px
    const w = new Win({ x: 20, y: 60, width: 1400, height: 880 }); w.maximizeMode = 3; windows.push(w);
    workspace.windowAdded(w); // setup() runs as on script load
    assert.strictEqual(R(w.frameGeometry), "12,52 1416x896");
});

test("shipped defaults: edges 32, between 16, scenic 80/80", () => {
    useShippedDefaults = true;
    const root = new Tile("QuickRootTile", null, { x: 0, y: 0, w: 1, h: 1 });
    const left = new Tile("Tile", root, { x: 0, y: 0, w: 0.5, h: 1 });
    const right = new Tile("Tile", root, { x: 0.5, y: 0, w: 0.5, h: 1 });
    const a = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    const b = addWindow({ x: 0, y: 0, width: 300, height: 300 });
    left.manage(a); right.manage(b);
    assert.strictEqual(R(a.frameGeometry), "32,72 680x856");
    assert.strictEqual(b.frameGeometry.x - (a.frameGeometry.x + a.frameGeometry.width), 16);
    const m = addWindow({ x: 100, y: 100, width: 800, height: 600 });
    m.setMaximize(true, true); flush();
    assert.strictEqual(R(m.frameGeometry), "32,72 1376x856");
    workspace.activeWindow = m; toggle(); flush();
    assert.strictEqual(R(m.frameGeometry), "80,120 1280x760");
    useShippedDefaults = false;
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
