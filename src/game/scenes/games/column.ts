/** Mini-game layout helpers (pure: no Phaser import, so tests can run them). */

/** The part of Phaser's ScaleManager `fitParent` uses. */
export interface ParentScale {
  /** Re-reads the parent's size; true when it changed since the last look. */
  getParentBounds(): boolean;
  /** Resizes the game (RESIZE mode: to the parent) and tells the scenes. */
  refresh(): unknown;
}

/**
 * Lays a game out at the size its parent has now. In the side panel the stage grows from the city's strip to the whole
 * panel when a game opens (01-layout.css `view-game`), but Phaser only looks at the parent every 500 ms: a scene that
 * started first was laid out in the old 282 px strip and kept it, with blank canvas under it, once its round was live.
 */
export function fitParent(scale: ParentScale) {
  if (scale.getParentBounds()) scale.refresh();
}

/**
 * The play column (MiniGame.column): the view under the chrome (`top`), at most `maxW` wide and centred. `contentH` is
 * the height the game's layout wants: on a tall view the spare room goes mostly below it (`y` is the column's top), on
 * a short one the column starts at `top`. `h` is the column's height: the content's, or the whole room when it gave none.
 */
export function playColumn(vw: number, vh: number, top: number, contentH = 0, maxW = 760) {
  const w = Math.min(vw, maxW);
  const x = Math.round((vw - w) / 2);
  const room = vh - top;
  const y = top + Math.max(0, Math.round((room - contentH) * 0.4));
  return { x, y, w, r: x + w, cx: Math.round(x + w / 2), h: Math.min(room, Math.max(contentH, 0) || room), bottom: vh };
}
