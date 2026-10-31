# Scenic View

A KWin script for **KDE Plasma 6** that adds gaps around tiled and maximized windows
and a **scenic view**: a maximize with larger margins, so more of your wallpaper
stays visible.

It does no automatic tiling and has no layouts of its own. It works with what KWin
already does: quick tiling (Meta+arrow keys, dragging to screen edges), custom tile
layouts (Meta+T) and maximizing.

## Features

- **Gaps for tiled windows**: one gap between tiled windows, separate gaps to the
  screen edges for left/right and top/bottom.
- **Gaps for maximized windows**: maximizing (title bar double-click, maximize
  button, Meta+PgUp) leaves the edge gaps free. The window stays a real maximized
  window, so the maximize button, un-maximize and drag-to-restore keep working.
- **Gaps are measured to panels**, not to the screen edge. Since maximized windows
  no longer touch a floating panel, the panel stays floating.
- **Scenic view**: a shortcut (default **Meta+Alt+S**) toggles the active window
  into a maximize with larger, separately configurable margins. Press it again and
  the window goes back to where it was: maximized with gaps, floating, or tiled.
- **Robust against KWin re-layouts**: when panels, screens or tile sizes change,
  KWin resets window geometry and the script re-applies the gaps.

## Compatibility

| Plasma / KWin | Status |
|---|---|
| **6.7** | Tested (6.7.5, Wayland, Bazzite) |
| **6.3 – 6.6** | Expected to work: all APIs the script uses exist in these versions (checked against the KWin source), but not tested |
| 6.0 – 6.2 | Not supported: `Window.maximizeMode` is not available to scripts |
| Plasma 5 | Not supported (different scripting API) |

The script was developed and tested in a Wayland session. On X11, KWin offers the
same scripting API, but this has not been tried.

## Installation

```bash
git clone https://github.com/twiebe/kde-scenic-view.git
cd kde-scenic-view
./install.sh
```

`install.sh` installs the script for the current user with `kpackagetool6`, enables
it and reloads KWin. It needs no root. Run it again to update; it upgrades the
package and restarts the script.

Manual installation:

```bash
kpackagetool6 --type=KWin/Script --install package
```

Then enable "Scenic View" under System Settings → Window Management → KWin Scripts.

Uninstall with `./uninstall.sh` (or `kpackagetool6 --type=KWin/Script --remove scenicview`).

## Configuration

System Settings → Window Management → KWin Scripts → Scenic View → gear icon.

> [!IMPORTANT]
> **Changed settings take effect only after the script is reloaded:** uncheck
> Scenic View in the list, click **Apply**, check it again, click **Apply**.
> Alternatively, run `./install.sh` again.

| Setting | Default | Applies to |
|---|---|---|
| Edges, left/right | 32 px | tiled and maximized windows |
| Edges, top/bottom | 32 px | tiled and maximized windows |
| Between tiled windows | 16 px | tiled windows |
| Also apply to custom tile layouts (Meta+T editor) | on | custom tiles |
| Scenic view margin, left/right | 80 px | scenic view |
| Scenic view margin, top/bottom | 80 px | scenic view |

Values are in logical pixels, so they scale with your display scaling. Scenic
margins are capped so a window never shrinks below half the work area.

**Shortcut:** System Settings → Keyboard → Shortcuts → KWin → "Toggle Scenic View".

## How it works

- **Between tiles:** KWin tiles have a single `padding` property, which puts half the
  padding between neighboring tiles and the full padding at the screen edges. Quick
  tiles are created with padding 0. The script sets the padding to the "between"
  gap on the root tile of whatever tile a window enters, so KWin itself handles the
  space between tiles.
- **Edges of tiles:** the script moves the sides of a tiled window that touch the
  work area edge to the configured edge gaps. KWin keeps the window in its tile.
  Whenever KWin re-applies the tile geometry (tile resize, panel or screen change),
  the script adjusts the edges again. While you drag a tile border, it waits until
  you let go.
- **Maximized windows:** KWin keeps a window maximized when a script changes its
  geometry, so the script shrinks maximized windows by the edge gaps. When KWin
  resets a maximized window to the full work area, the window reaches into the
  margin again and the script shrinks it again.
- **Scenic view** is a maximized window with the scenic margins. Un-maximizing or
  dragging the window ends scenic view.
- **Custom tile layouts:** with the option enabled, the "between" gap is written to
  the layout's padding. That is the same value as the gap in the Meta+T editor and
  gets saved to `kwinrc`. Disable the option to leave custom layouts alone.

## Known limitations

- **Decorations:** maximized windows keep the maximized decoration, so Breeze draws
  square corners and no side borders even though the window doesn't touch the edges.
- **Size increments:** apps that resize only in fixed steps (some terminals under
  Xwayland) may end up a few pixels short of the gap on one side. The script accepts
  that instead of fighting the app.
- **Manual placement:** only tiled and maximized windows get gaps. Windows you place
  or resize by hand against an edge are left alone.
- **Scenic view after reload:** reloading the script forgets which windows were in
  scenic view. They become regular maximized windows with gaps.
- **Settings need a reload** (see above). KWin re-reads script settings only when the
  script restarts.

## Troubleshooting

Script errors and messages are logged to the journal:

```bash
journalctl --user -b | grep -iE 'scenic|js:'
```

## Development

```
package/
  metadata.json            KWin script metadata
  contents/code/main.js    the script
  contents/config/main.xml settings schema
  contents/ui/config.ui    settings dialog
tests/kwin-mock.test.js    tests against a KWin API mock
```

Run the tests with Node.js:

```bash
node tests/kwin-mock.test.js package/contents/code/main.js
```

The mock is modeled on the KWin 6.7.5 source: asynchronous maximize, partial
maximize, tile padding inheritance and propagation, and the 6.3 `window.tile`
fallback. The tests cover gaps for maximized and tiled windows (including edge gaps
smaller than the "between" gap), work area changes, tile border dragging, scenic view
from maximized, floating and tiled windows, size-increment clients, clients that
refuse the smaller size, and script reloads. The mock is not KWin; check changes in a
real session too.

## License

[MIT](LICENSE) © 2026 Thomas Wiebe
