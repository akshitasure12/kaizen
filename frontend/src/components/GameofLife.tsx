import { useEffect, useRef, useCallback } from "react";

interface GameOfLifeBackgroundProps {
  cellSize?: number;
  cellColor?: string;
  bgColor?: string;
  tickInterval?: number;
  initialDensity?: number;
  focalPoint?: { x: number; y: number };
  densityThreshold?: number;   // NEW: default 0.05
  refillDensity?: number;      // NEW: target density to refill to, default 0.12
}

// ─── Patterns ────────────────────────────────────────────────────────────────

const GLIDER: [number, number][] = [
  [1, 0], [2, 1], [0, 2], [1, 2], [2, 2],
];

const LWSS: [number, number][] = [
  [1, 0], [4, 0],
  [0, 1],
  [0, 2], [4, 2],
  [0, 3], [1, 3], [2, 3], [3, 3],
];

const GOSPER_GUN: [number, number][] = [
  [24,0],
  [22,1],[24,1],
  [12,2],[13,2],[20,2],[21,2],[34,2],[35,2],
  [11,3],[15,3],[20,3],[21,3],[34,3],[35,3],
  [0,4],[1,4],[10,4],[16,4],[20,4],[21,4],
  [0,5],[1,5],[10,5],[14,5],[16,5],[17,5],[22,5],[24,5],
  [10,6],[16,6],[24,6],
  [11,7],[15,7],
  [12,8],[13,8],
];

const R_PENTOMINO: [number, number][] = [
  [1,0],[2,0],
  [0,1],[1,1],
  [1,2],
];

const DIEHARD: [number, number][] = [
  [6,0],
  [0,1],[1,1],
  [1,2],[5,2],[6,2],[7,2],
];

const ACORN: [number, number][] = [
  [1, 0],
  [3,1],
  [0, 2], [1, 2], [4, 2], [5, 2], [6, 2],
];

export default function GameOfLifeBackground({
  cellSize = 10,
  cellColor = "#3d3d3d",
  bgColor = "#0a0a0f",
  tickInterval = 100,
  initialDensity = 0.8,
  focalPoint,
  densityThreshold = 0.5,
  refillDensity = 0.12,
}: GameOfLifeBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  const gaussianProb = useCallback(
    (dx: number, dy: number, sx: number, sy: number) =>
      Math.exp(-((dx * dx) / (2 * sx * sx) + (dy * dy) / (2 * sy * sy))),
    []
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cols = 0, rows = 0;
    let grid = new Uint8Array(0);
    let next = new Uint8Array(0);
    let animId = 0;
    let lastTick = 0;

    // ─── Drip queue ──────────────────────────────────────────────────────────
    // Each entry is a list of flat indices to revive on a future generation.
    // We push 3 batches so the revival plays out over 3 ticks.
    let dripQueue: number[][] = [];

    const stamp = (pattern: [number, number][], col: number, row: number) => {
      for (const [dc, dr] of pattern) {
        const c = col + dc;
        const r = row + dr;
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
          grid[r * cols + c] = 1;
        }
      }
    };

    const placePatterns = () => {
      const margin = 10;
      stamp(GOSPER_GUN, margin, margin);
      stamp(GOSPER_GUN, cols - 40 - margin, rows - 10 - margin);
      stamp(LWSS, margin, rows / 2);
      stamp(LWSS, cols - 10, rows / 3);
      stamp(R_PENTOMINO, cols / 2, rows / 2);
      stamp(ACORN, cols / 2 + 20, rows / 2 - 10);
      for (let i = 0; i < 4; i++) {
        stamp(GLIDER,
          Math.floor(Math.random() * cols * 0.6 + cols * 0.2),
          Math.floor(Math.random() * rows * 0.6 + rows * 0.2)
        );
      }
    };

    const reseedGrid = () => {
      cols = Math.ceil(canvas.width / cellSize);
      rows = Math.ceil(canvas.height / cellSize);
      grid = new Uint8Array(cols * rows);
      next = new Uint8Array(cols * rows);
      dripQueue = [];

      const cx = focalPoint ? focalPoint.x / cellSize : cols / 2;
      const cy = focalPoint ? focalPoint.y / cellSize : rows / 2;
      const sigmaX = cols * 0.45;
      const sigmaY = rows * 0.45;

      placePatterns();

      const base = initialDensity * 0.15;
      const boost = initialDensity * 0.15;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (grid[idx] === 1) continue;
          const g = gaussianProb(c - cx, r - cy, sigmaX, sigmaY);
          const prob = base + boost * g;
          grid[idx] = Math.random() < prob ? 1 : 0;
        }
      }
    };

    // ─── Density helpers ─────────────────────────────────────────────────────

    const getLiveDensity = () => {
      let alive = 0;
      for (let i = 0; i < grid.length; i++) alive += grid[i];
      return alive / grid.length;
    };

    /**
     * Collect the indices of all currently-dead cells, shuffle them, then
     * split the ones we want to revive across `waves` equal batches so each
     * batch can be applied on a separate generation tick.
     */
    const scheduleDrip = (waves = 3) => {
      const total = cols * rows;
      const currentAlive = grid.reduce((s, v) => s + v, 0);
      const targetAlive = Math.floor(refillDensity * total);
      const needed = Math.max(0, targetAlive - currentAlive);
      if (needed === 0) return;

      // Gather dead-cell indices and shuffle (Fisher-Yates)
      const dead: number[] = [];
      for (let i = 0; i < total; i++) {
        if (grid[i] === 0) dead.push(i);
      }
      for (let i = dead.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [dead[i], dead[j]] = [dead[j], dead[i]];
      }

      const chosen = dead.slice(0, needed);
      const batchSize = Math.ceil(chosen.length / waves);

      // Push `waves` batches onto the queue
      for (let w = 0; w < waves; w++) {
        dripQueue.push(chosen.slice(w * batchSize, (w + 1) * batchSize));
      }
    };

    // ─── Apply one drip batch (called once per tick) ──────────────────────────
    const applyDrip = () => {
      if (dripQueue.length === 0) return;
      const batch = dripQueue.shift()!;
      for (const idx of batch) {
        grid[idx] = 1;
      }
    };

    // ─── Cursor repulsion ────────────────────────────────────────────────────
    const REPEL_RADIUS = 6; // cells
    const REPEL_FORCE  = 3; // extra cells pushed beyond radius

    const repelCells = () => {
      const mouse = mouseRef.current;
      if (!mouse) return;
      const mcx = mouse.x / cellSize;
      const mcy = mouse.y / cellSize;

      const r0 = Math.max(0, Math.floor(mcy - REPEL_RADIUS - 1));
      const r1 = Math.min(rows - 1, Math.ceil(mcy + REPEL_RADIUS + 1));
      const c0 = Math.max(0, Math.floor(mcx - REPEL_RADIUS - 1));
      const c1 = Math.min(cols - 1, Math.ceil(mcx + REPEL_RADIUS + 1));

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const idx = r * cols + c;
          if (!grid[idx]) continue;
          const dx = c + 0.5 - mcx;
          const dy = r + 0.5 - mcy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d >= REPEL_RADIUS) continue;

          // Kill at current position
          grid[idx] = 0;

          // Push direction (away from cursor)
          const len = d < 0.01 ? 1 : d;
          const nx = dx / len;
          const ny = dy / len;
          const push = REPEL_RADIUS - d + REPEL_FORCE;
          const tc = Math.round(c + nx * push);
          const tr = Math.round(r + ny * push);
          if (tc >= 0 && tc < cols && tr >= 0 && tr < rows) {
            grid[tr * cols + tc] = 1;
          }
        }
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const handleMouseLeave = () => {
      mouseRef.current = null;
    };

    const countNeighbours = (c: number, r: number) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = c + dx;
          const y = r + dy;
          if (x >= 0 && x < cols && y >= 0 && y < rows) {
            n += grid[y * cols + x];
          }
        }
      }
      return n;
    };

    const step = () => {
      // 1. Check density and queue a drip if needed (only when queue is empty
      //    so we don't stack multiple refill waves on top of each other).
      if (dripQueue.length === 0 && getLiveDensity() < densityThreshold) {
        scheduleDrip(3);
      }

      // 2. Apply the next pending drip batch *before* the GOL step so the
      //    new cells participate in this generation's neighbour counts.
      applyDrip();

      // 3. Normal GOL tick.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const alive = grid[idx];
          const n = countNeighbours(c, r);
          next[idx] =
            alive === 1
              ? (n === 2 || n === 3 ? 1 : 0)
              : (n === 3 ? 1 : 0);
        }
      }

      const tmp = grid;
      grid = next;
      next = tmp;
    };

    const draw = () => {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = cellColor;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (grid[r * cols + c]) {
            ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 1, cellSize - 1);
          }
        }
      }
    };

    const loop = (t: number) => {
      animId = requestAnimationFrame(loop);
      repelCells();
      draw();
      if (t - lastTick >= tickInterval) {
        step();
        lastTick = t;
      }
    };

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      reseedGrid();
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseleave", handleMouseLeave);
    animId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [cellSize, cellColor, bgColor, tickInterval, initialDensity,
      focalPoint?.x, focalPoint?.y, densityThreshold, refillDensity]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}