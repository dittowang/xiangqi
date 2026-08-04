/**
 * Contact sheets: N frames of one clip, composed into a single labelled image.
 *
 * This exists because the motion critic is a model that opens PNG files. It
 * cannot scrub a video and it cannot hold sixteen separate images in its head
 * at once — but it can read a grid where every cell carries its frame index and
 * its elapsed time, and say "the hold on beat two is four frames too long".
 * A clip that is not delivered as a sheet is a clip that does not get judged.
 *
 * `node-canvas` is not available (and could not be added anyway), so the
 * composition runs in the browser: a 2D canvas in the driver's scratch page,
 * fed one cell at a time so peak memory is one frame rather than all of them,
 * and read back as a PNG data URL. Cells are drawn from the *captured PNGs*, so
 * a sheet is always made of frames that really landed on disk.
 *
 * Every colour here comes from `core/palette.ts`, like everything else in the
 * project. A sheet is a tool output, but it is also the thing a human squints
 * at for an hour, and ink-on-shell-white is easier to read for an hour than
 * whatever the browser's defaults are.
 */

import type { Page } from '@playwright/test';
import { PIGMENTS } from '@core/palette.ts';

/** Sheet chrome, resolved from the pigment ramps rather than invented. */
const CHROME = {
  page: PIGMENTS.ink.bands[0], //  墨 0 — deepest value in the project
  cellBackdrop: PIGMENTS.ink.bands[1],
  hairline: PIGMENTS.stone.bands[1],
  title: PIGMENTS.shellWhite.bands[3],
  caption: PIGMENTS.shellWhite.bands[1],
  index: PIGMENTS.gold.bands[3],
  alert: PIGMENTS.cinnabar.bands[3],
} as const;

const PAD = 14;
const GUTTER = 8;
const LABEL_H = 22;
const HEADER_H = 56;

export interface SheetOptions {
  /** Drawn across the top of the sheet. */
  title: string;
  /** Second line of the header: the FEN, the pair, the gait — whatever locates it. */
  subtitle?: string;
  /** How many cells will be added. Fixes the grid before the first draw. */
  count: number;
  /** width / height of one frame. Drives the grid shape. */
  cellAspect: number;
  /** Override the automatic column count. */
  cols?: number;
  /** Longest edge of the finished sheet, px. Default 1600. */
  maxLongEdge?: number;
}

export interface SheetLayout {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  width: number;
  height: number;
}

export interface SheetResult extends SheetLayout {
  png: Buffer;
  bytes: number;
}

/**
 * Grid shape. Cells are laid out to bring the finished sheet near 3:2, which is
 * the shape that survives being viewed at whatever width a reader has, without
 * any single cell getting so small the beat is unreadable.
 */
export function chooseColumns(count: number, cellAspect: number): number {
  if (count <= 1) return 1;
  const target = 1.5;
  let best = 1;
  let bestErr = Infinity;
  for (let cols = 1; cols <= Math.min(count, 8); cols++) {
    const rows = Math.ceil(count / cols);
    const aspect = (cols * cellAspect) / rows;
    // Penalise ragged final rows a little; a 4x4 reads better than 5+5+5+1.
    const ragged = (cols * rows - count) / count;
    const err = Math.abs(Math.log(aspect / target)) + ragged * 0.35;
    if (err < bestErr) {
      bestErr = err;
      best = cols;
    }
  }
  return best;
}

export function layoutSheet(opts: SheetOptions): SheetLayout {
  const maxEdge = opts.maxLongEdge ?? 1600;
  const cols = Math.max(1, opts.cols ?? chooseColumns(opts.count, opts.cellAspect));
  const rows = Math.ceil(opts.count / cols);

  // Solve the cell width against both budgets and take the tighter one, so a
  // tall sheet (few columns, many rows) is bounded by its height.
  const byWidth = (maxEdge - PAD * 2 - GUTTER * (cols - 1)) / cols;
  const cellHFromHeight = (maxEdge - HEADER_H - PAD * 2 - GUTTER * (rows - 1)) / rows - LABEL_H;
  const byHeight = cellHFromHeight * opts.cellAspect;

  const cellW = Math.max(64, Math.floor(Math.min(byWidth, byHeight)));
  const cellH = Math.max(48, Math.round(cellW / opts.cellAspect));
  const width = PAD * 2 + cols * cellW + GUTTER * (cols - 1);
  const height = HEADER_H + PAD * 2 + rows * (cellH + LABEL_H) + GUTTER * (rows - 1);
  return { cols, rows, cellW, cellH, width, height };
}

/**
 * A sheet under construction. Open it, `add()` each frame as it is captured,
 * then `finish()`. Frames are drawn and released one at a time.
 */
export class SheetSession {
  private index = 0;

  private constructor(
    private readonly page: Page,
    readonly layout: SheetLayout,
    private readonly opts: SheetOptions,
  ) {}

  static async open(page: Page, opts: SheetOptions): Promise<SheetSession> {
    const layout = layoutSheet(opts);
    await page.evaluate(
      (a) => {
        const c = document.createElement('canvas');
        c.width = a.layout.width;
        c.height = a.layout.height;
        const g = c.getContext('2d')!;
        g.fillStyle = a.chrome.page;
        g.fillRect(0, 0, c.width, c.height);

        // Header. Generic font families only — this project ships no font files
        // and does not load any, here or anywhere else.
        // A motion sheet's subtitle carries a whole FEN, so both lines are
        // clamped rather than allowed to run off the right edge.
        const maxW = c.width - a.pad * 2;
        const clamp = (text: string) => {
          if (g.measureText(text).width <= maxW) return text;
          let s = text;
          while (s.length > 4 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
          return s + '…';
        };
        g.textBaseline = 'alphabetic';
        g.fillStyle = a.chrome.title;
        g.font = '600 20px system-ui, -apple-system, "Segoe UI", sans-serif';
        g.fillText(clamp(a.title), a.pad, 24);
        if (a.subtitle) {
          g.fillStyle = a.chrome.caption;
          g.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
          g.fillText(clamp(a.subtitle), a.pad, 42);
        }
        // The rule sits below the descenders of the subtitle, not through them.
        const ruleY = a.headerH - 6.5;
        g.strokeStyle = a.chrome.hairline;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(a.pad, ruleY);
        g.lineTo(c.width - a.pad, ruleY);
        g.stroke();

        (window as unknown as { __sheet?: unknown }).__sheet = { canvas: c, ctx: g };
      },
      {
        layout,
        chrome: CHROME,
        title: opts.title,
        subtitle: opts.subtitle ?? '',
        pad: PAD,
        headerH: HEADER_H,
      },
    );
    return new SheetSession(page, layout, opts);
  }

  /**
   * Draw one frame. `label` is the big index ("04"), `caption` the small line
   * under it ("t 0.267 · 267 ms"). Both are burned into the image — a critic
   * quoting "cell 11" must be quoting something the picture actually says.
   */
  async add(png: Buffer, label: string, caption = '', flag = false): Promise<void> {
    const i = this.index++;
    const col = i % this.layout.cols;
    const row = Math.floor(i / this.layout.cols);
    const x = PAD + col * (this.layout.cellW + GUTTER);
    const y = HEADER_H + PAD + row * (this.layout.cellH + LABEL_H + GUTTER);

    await this.page.evaluate(
      async (a) => {
        const sheet = (window as unknown as { __sheet: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } })
          .__sheet;
        const g = sheet.ctx;

        const img = new Image();
        img.src = a.dataUri;
        await img.decode();

        g.save();
        g.fillStyle = a.chrome.cellBackdrop;
        g.fillRect(a.x, a.y, a.cellW, a.cellH);

        // Contain the frame inside the cell; a clip-based cell has its own
        // aspect and must not be stretched to fit the grid.
        const s = Math.min(a.cellW / img.naturalWidth, a.cellH / img.naturalHeight);
        const dw = Math.round(img.naturalWidth * s);
        const dh = Math.round(img.naturalHeight * s);
        const dx = a.x + Math.round((a.cellW - dw) / 2);
        const dy = a.y + Math.round((a.cellH - dh) / 2);

        // A cell is typically a 3-4x reduction of a 1280x800 frame, and
        // `drawImage` samples roughly once per destination pixel — a single
        // draw at that ratio drops most of the detail and turns a spear into a
        // dotted line. Halve into scratch canvases until the last step is under
        // 2:1, which is what the browser's smoothing is actually good at.
        let src: CanvasImageSource = img;
        let sw = img.naturalWidth;
        let sh = img.naturalHeight;
        while (sw > dw * 2 && sh > dh * 2) {
          const hw = Math.max(dw, sw >> 1);
          const hh = Math.max(dh, sh >> 1);
          const c = document.createElement('canvas');
          c.width = hw;
          c.height = hh;
          const gg = c.getContext('2d')!;
          gg.imageSmoothingEnabled = true;
          gg.imageSmoothingQuality = 'high';
          gg.drawImage(src, 0, 0, hw, hh);
          src = c;
          sw = hw;
          sh = hh;
        }
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, dx, dy, dw, dh);

        g.strokeStyle = a.chrome.hairline;
        g.lineWidth = 1;
        g.strokeRect(a.x + 0.5, a.y + 0.5, a.cellW - 1, a.cellH - 1);

        // Index badge inside the frame, so a cropped or zoomed cell is still
        // identifiable on its own.
        const badge = a.label;
        g.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
        const bw = Math.ceil(g.measureText(badge).width) + 12;
        g.globalAlpha = 0.78;
        g.fillStyle = a.chrome.page;
        g.fillRect(a.x + 4, a.y + 4, bw, 19);
        g.globalAlpha = 1;
        g.fillStyle = a.flag ? a.chrome.alert : a.chrome.index;
        g.fillText(badge, a.x + 10, a.y + 18);

        // Caption strip under the cell.
        g.fillStyle = a.chrome.caption;
        g.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        const text = a.caption;
        const maxW = a.cellW - 4;
        let shown = text;
        while (shown.length > 4 && g.measureText(shown).width > maxW) shown = shown.slice(0, -2);
        if (shown !== text) shown = shown.slice(0, -1) + '…';
        g.fillText(shown, a.x + 2, a.y + a.cellH + 15);
        g.restore();
      },
      {
        dataUri: 'data:image/png;base64,' + png.toString('base64'),
        x,
        y,
        cellW: this.layout.cellW,
        cellH: this.layout.cellH,
        label,
        caption,
        flag,
        chrome: CHROME,
      },
    );
  }

  /** Read the composed sheet back as PNG bytes and release the page canvas. */
  async finish(): Promise<SheetResult> {
    const dataUrl = await this.page.evaluate(() => {
      const w = window as unknown as { __sheet?: { canvas: HTMLCanvasElement } };
      const url = w.__sheet!.canvas.toDataURL('image/png');
      delete w.__sheet; // let the canvas go; sheets are large
      return url;
    });
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    return { ...this.layout, png, bytes: png.length };
  }

  /** How many cells the grid expects, for a caller that wants to pad it out. */
  get expected(): number {
    return this.opts.count;
  }
}
