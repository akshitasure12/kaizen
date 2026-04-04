"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ─── Data ──────────────────────────────────────────────────────────────────
interface Phase {
  label: string;
  title: string;
  body: string;
}

const phases: Phase[] = [
  {
    label: "Phase 01",
    title: "Ideation & Setup",
    body: "Defined the core problem space. Scoped the MVP, assembled the stack, and initialized the repo. Named the project Kaizen — continuous improvement, one commit at a time.",
  },
  {
    label: "Phase 02",
    title: "Architecture & Design",
    body: "Mapped out system components and data flow. Designed the UI language — black, white, grey, alive. Built the Conway's Game of Life background as a metaphor: emergent complexity from simple rules.",
  },
  {
    label: "Phase 03",
    title: "Core Development",
    body: "Wrote the engine. Feature after feature snapped into place. Late-night commits, rubber duck debugging, and the occasional triumphant console.log. The thing started feeling real.",
  },
  {
    label: "Phase 04",
    title: "Integration & Testing",
    body: "Stitched the pieces together. Hunted bugs across the stack, stress-tested edge cases, and ensured every interaction felt intentional. Broke things. Fixed things. Broke them better.",
  },
  {
    label: "Phase 05",
    title: "Polish & Presentation",
    body: "Refined the rough edges. Animations tightened, copy sharpened, demo rehearsed. Everything that made Kaizen distinct got amplified. Shipped something we're proud to show.",
  },
];

export const KAIZEN_TIMELINE_PHASE_COUNT = phases.length;

// ─── Conway's Game of Life ──────────────────────────────────────────────────
function useGameOfLife(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const stateRef = useRef<Uint8Array | null>(null);
  const nextRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const CELL = 14;
  const TICK_MS = 120;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth || window.innerWidth;
      canvas.height = canvas.offsetHeight || window.innerHeight;
      const cols = Math.ceil(canvas.width / CELL);
      const rows = Math.ceil(canvas.height / CELL);
      const size = cols * rows;
      stateRef.current = new Uint8Array(size);
      nextRef.current = new Uint8Array(size);
      // seed ~18% alive
      for (let i = 0; i < size; i++) {
        stateRef.current[i] = Math.random() < 0.18 ? 1 : 0;
      }
    };

    resize();
    window.addEventListener("resize", resize);

    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      const canvas = canvasRef.current;
      if (!canvas || !stateRef.current || !nextRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cols = Math.ceil(canvas.width / CELL);
      const rows = Math.ceil(canvas.height / CELL);

      // Update logic at TICK_MS intervals
      if (now - lastTickRef.current > TICK_MS) {
        lastTickRef.current = now;
        const cur = stateRef.current;
        const nxt = nextRef.current;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            let n = 0;
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = (r + dr + rows) % rows;
                const nc = (c + dc + cols) % cols;
                n += cur[nr * cols + nc];
              }
            }
            const alive = cur[r * cols + c];
            nxt[r * cols + c] =
              alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
          }
        }
        stateRef.current.set(nxt);
      }

      // Draw
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cur = stateRef.current;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (cur[r * cols + c]) {
            ctx.fillStyle = "rgba(255,255,255,0.045)";
            ctx.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
          }
        }
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [canvasRef]);
}

// ─── Main Component ──────────────────────────────────────────────────────────
type KaizenTimelineProps = {
  /** When set, phase is driven by parent (e.g. document scroll). Wheel/touch step navigation is disabled. */
  controlledPhase?: number;
};

export default function KaizenTimeline({ controlledPhase }: KaizenTimelineProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackWrapperRef = useRef<HTMLDivElement>(null);
  const golRef = useRef<HTMLCanvasElement>(null);
  const timelineCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const isMostlyVisible = useRef(false);

  const [current, setCurrent] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const [textVisible, setTextVisible] = useState(true);
  const [trackX, setTrackX] = useState(0);

  const prevCurrent = useRef(0);
  const scrollAccum = useRef(0);
  const isThrottled = useRef(false);
  const segmentLit = useRef<number[]>(new Array(phases.length - 1).fill(0));

  const rayAnim = useRef<{
    rafId: number | null;
    startTime: number;
    fromIdx: number;
    toIdx: number;
  }>({ rafId: null, startTime: 0, fromIdx: 0, toIdx: 0 });

  const centerActiveNode = useCallback(() => {
    const node = nodeRefs.current[current];
    const trackViewport = trackWrapperRef.current;
    if (!node || !trackViewport) return;
    const viewportWidth = trackViewport.offsetWidth || window.innerWidth;
    const nodeCenter = node.offsetLeft + node.offsetWidth / 2;
    setTrackX(viewportWidth / 2 - nodeCenter);
  }, [current]);

  // Boot Game of Life
  useGameOfLife(golRef);

  // ─── Visibility gate (IntersectionObserver) ───────────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { isMostlyVisible.current = entry.intersectionRatio >= 0.6; },
      { threshold: [0, 0.6, 1] }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ─── Timeline canvas draw ─────────────────────────────────────────────────
  const drawTimeline = useCallback((rayT: number, rayEased: number, rayFrom: number, rayTo: number) => {
    const canvas = timelineCanvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return;

    const h = track.offsetHeight || 200;
    canvas.width = track.scrollWidth;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cy = h / 2;

    for (let i = 0; i < phases.length - 1; i++) {
      const n1 = nodeRefs.current[i];
      const n2 = nodeRefs.current[i + 1];
      if (!n1 || !n2) continue;
      const x1 = n1.offsetLeft + n1.offsetWidth / 2;
      const x2 = n2.offsetLeft + n2.offsetWidth / 2;
      const lit = segmentLit.current[i];

      ctx.beginPath();
      ctx.moveTo(x1, cy);
      ctx.lineTo(x2, cy);
      ctx.strokeStyle = "#1c1c1c";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (lit > 0) {
        const litX = x1 + (x2 - x1) * lit;
        ctx.beginPath();
        ctx.moveTo(x1, cy);
        ctx.lineTo(litX, cy);
        ctx.strokeStyle = "#505050";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    const segIdx = Math.min(rayFrom, rayTo);
    const n1 = nodeRefs.current[segIdx];
    const n2 = nodeRefs.current[segIdx + 1];
    if (n1 && n2 && rayT < 1 && rayFrom !== rayTo) {
      const x1 = n1.offsetLeft + n1.offsetWidth / 2;
      const x2 = n2.offsetLeft + n2.offsetWidth / 2;
      const dir = rayTo > rayFrom ? 1 : -1;
      const rayX = dir > 0
        ? x1 + (x2 - x1) * rayEased
        : x2 - (x2 - x1) * rayEased;
      const trailStart = dir > 0 ? x1 : x2;

      // Trail glow
      const grad = ctx.createLinearGradient(trailStart, cy, rayX, cy);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.6, "rgba(255,255,255,0.06)");
      grad.addColorStop(1, "rgba(255,255,255,0.6)");
      ctx.beginPath();
      ctx.moveTo(trailStart, cy);
      ctx.lineTo(rayX, cy);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Head glow
      const hg = ctx.createRadialGradient(rayX, cy, 0, rayX, cy, 14);
      hg.addColorStop(0, "rgba(255,255,255,1)");
      hg.addColorStop(0.3, "rgba(255,255,255,0.75)");
      hg.addColorStop(0.7, "rgba(255,255,255,0.2)");
      hg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.beginPath();
      ctx.arc(rayX, cy, 14, 0, Math.PI * 2);
      ctx.fillStyle = hg;
      ctx.fill();
    }
  }, []);

  // ─── Fire ray ────────────────────────────────────────────────────────────
  const fireRay = useCallback((fromIdx: number, toIdx: number) => {
    const ra = rayAnim.current;
    if (ra.rafId) cancelAnimationFrame(ra.rafId);
    ra.fromIdx = fromIdx;
    ra.toIdx = toIdx;
    ra.startTime = performance.now();
    const segIdx = Math.min(fromIdx, toIdx);
    const DURATION = 560;

    const tick = (now: number) => {
      const t = Math.min(1, (now - ra.startTime) / DURATION);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      segmentLit.current[segIdx] = toIdx > fromIdx ? eased : 1 - eased;
      drawTimeline(t, eased, fromIdx, toIdx);
      if (t < 1) {
        ra.rafId = requestAnimationFrame(tick);
      } else {
        ra.rafId = null;
        segmentLit.current = segmentLit.current.map((_, index) =>
          index < toIdx ? 1 : 0
        );
        drawTimeline(1, 1, fromIdx, toIdx);
      }
    };
    ra.rafId = requestAnimationFrame(tick);
  }, [drawTimeline]);

  // ─── Transition to phase ─────────────────────────────────────────────────
  const goTo = useCallback((next: number) => {
    if (next === prevCurrent.current) return;
    const from = prevCurrent.current;
    prevCurrent.current = next;
    setCurrent(next);
    fireRay(from, next);
    setTextVisible(false);
    setTimeout(() => { setDisplayIndex(next); setTextVisible(true); }, 230);
  }, [fireRay]);

  const applyPhaseInstant = useCallback((next: number) => {
    const ra = rayAnim.current;
    if (ra.rafId) cancelAnimationFrame(ra.rafId);
    ra.rafId = null;
    prevCurrent.current = next;
    setCurrent(next);
    setDisplayIndex(next);
    setTextVisible(true);
    segmentLit.current = segmentLit.current.map((_, i) => (i < next ? 1 : 0));
    drawTimeline(1, 1, next, next);
  }, [drawTimeline]);

  // ─── Controlled phase (scroll-driven from parent) ─────────────────────────
  useEffect(() => {
    if (controlledPhase === undefined) return;
    const target = Math.max(0, Math.min(phases.length - 1, Math.round(controlledPhase)));
    const from = prevCurrent.current;
    if (target === from) return;
    if (Math.abs(target - from) === 1) {
      goTo(target);
    } else {
      applyPhaseInstant(target);
    }
  }, [controlledPhase, goTo, applyPhaseInstant]);

  // ─── Scroll hijack (wheel + touch) ───────────────────────────────────────
  useEffect(() => {
    if (controlledPhase !== undefined) return;

    const THRESH = 20;

    const onWheel = (e: WheelEvent) => {
      if (!isMostlyVisible.current) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      const atStart = prevCurrent.current === 0 && dir < 0;
      const atEnd = prevCurrent.current === phases.length - 1 && dir > 0;
      if (atStart || atEnd) {
        scrollAccum.current = 0;
        return; // release control back to the page
      }
      e.preventDefault();
      if (isThrottled.current) return;
      scrollAccum.current += e.deltaY;
      if (Math.abs(scrollAccum.current) >= THRESH) {
        scrollAccum.current = 0;
        const next = Math.max(0, Math.min(phases.length - 1, prevCurrent.current + dir));
        if (next !== prevCurrent.current) {
          goTo(next);
          isThrottled.current = true;
          setTimeout(() => { isThrottled.current = false; }, 380);
        }
      }
    };

    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0].clientY; };
    const onTouchEnd = (e: TouchEvent) => {
      const dy = touchStartY - e.changedTouches[0].clientY;
      if (Math.abs(dy) < 40) return;
      const dir = dy > 0 ? 1 : -1;
      const next = Math.max(0, Math.min(phases.length - 1, prevCurrent.current + dir));
      goTo(next);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") goTo(Math.min(phases.length - 1, prevCurrent.current + 1));
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") goTo(Math.max(0, prevCurrent.current - 1));
    };

    const el = trackWrapperRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("keydown", onKey);
    };
  }, [goTo, controlledPhase]);

  // ─── Center active node ───────────────────────────────────────────────────
  useEffect(() => {
    centerActiveNode();
  }, [centerActiveNode]);

  // ─── Initial draw ─────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => drawTimeline(1, 1, 0, 0), 150);
    return () => clearTimeout(t);
  }, [drawTimeline]);

  useEffect(() => {
    const onResize = () => {
      centerActiveNode();
      drawTimeline(1, 1, rayAnim.current.fromIdx, rayAnim.current.toIdx);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [centerActiveNode, drawTimeline]);

  const phase = phases[displayIndex];

  return (
    <>
      <style>{`
        @keyframes kz-pulse {
          0%   { transform: scale(1);   opacity: 0.6; }
          100% { transform: scale(2.8); opacity: 0; }
        }
        @keyframes kz-dot-pop {
          0%   { transform: scale(0.4); opacity: 0; }
          65%  { transform: scale(1.25); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes kz-text-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes kz-text-out {
          from { opacity: 1; transform: translateY(0); }
          to   { opacity: 0; transform: translateY(-10px); }
        }
        @keyframes kz-fade-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }

        .kz-root .kz-pulse-ring::after {
          content: '';
          position: absolute;
          width: 10px; height: 10px;
          border-radius: 50%;
          background: #fff;
          animation: kz-pulse 2s ease-out infinite;
          pointer-events: none;
        }
        .kz-root .kz-dot-pop   { animation: kz-dot-pop  0.42s cubic-bezier(0.34,1.56,0.64,1) forwards; }
        .kz-root .kz-text-in   { animation: kz-text-in  0.4s  cubic-bezier(0.4,0,0.2,1) forwards; }
        .kz-root .kz-text-out  { animation: kz-text-out 0.22s ease forwards; }
        .kz-root .kz-fade-in   { animation: kz-fade-in  1.2s  ease forwards; }
        .kz-root .kz-scroll-hint { animation: kz-pulse 2.4s ease-out infinite; }
      `}</style>

      {/* ── Root: fills parent section ── */}
      <div ref={rootRef} className="kz-root" style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#000",
        fontFamily: "'Bricolage Grotesque', sans-serif",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}>

        {/* Game of Life canvas — full background */}
        <canvas
          ref={golRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />

        {/* Subtle radial vignette so center content pops */}
        <div style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 70% 70% at 50% 50%, transparent 30%, rgba(0,0,0,0.85) 100%)",
          pointerEvents: "none",
          zIndex: 1,
        }} />

        {/* ── Content layer ── */}
        <div className="kz-fade-in" style={{
          position: "relative",
          zIndex: 2,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
        }}>

          {/* Project name */}
          <div style={{
            fontSize: 48,
            fontWeight: 800,
            color: "#ffffff",
            marginBottom: 8,
            fontFamily: "inherit",
          }}>
            Project Timeline
          </div>

          <div style={{
            fontSize: 24,
            fontWeight: 400,
            letterSpacing: "0.18em",
            color: "#b0b0b0",
            fontFamily: "inherit",
          }}>
            Kaizen
          </div>

          {/* ── Timeline track ── */}
          <div ref={trackWrapperRef} style={{ position: "relative", width: "100%", overflow: "hidden" }}>
            <div style={{
              transform: `translateX(${trackX}px)`,
              transition: "transform 0.72s cubic-bezier(0.4,0,0.2,1)",
              width: "max-content",
              position: "relative",
            }}>
              {/* Canvas for line + ray */}
              <canvas
                ref={timelineCanvasRef}
                style={{
                  position: "absolute",
                  top: 0, left: 0,
                  pointerEvents: "none",
                  zIndex: 0,
                }}
              />

              {/* Nodes */}
              <div
                ref={trackRef}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "80px 160px",
                  position: "relative",
                  zIndex: 1,
                }}
              >
                {phases.map((p, i) => {
                  const isActive = i === current;
                  const isVisited = i < current;
                  const above = i % 2 === 0;

                  return (
                    <div
                      key={i}
                      ref={(el) => { nodeRefs.current[i] = el; }}
                      onClick={() => goTo(i)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        position: "relative",
                        margin: "0 80px",
                        flexShrink: 0,
                        cursor: "pointer",
                      }}
                    >
                      {above && (
                        <div style={{
                          fontSize: 14,
                          fontWeight: 500,
                          letterSpacing: "0.2em",
                          color: isActive ? "#ffffff" : "#868686",
                          textTransform: "uppercase",
                          position: "absolute",
                          bottom: "calc(100% + 20px)",
                          whiteSpace: "nowrap",
                          transition: "color 0.55s ease",
                          fontFamily: "inherit",
                        }}>
                          {p.label}
                        </div>
                      )}

                      {/* Dot */}
                      <div style={{
                        width: 52, height: 52,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                      }}>
                        <div style={{
                          position: "absolute", inset: 0,
                          borderRadius: "50%",
                          border: `1px solid ${isActive ? "#404040" : isVisited ? "#232323" : "#141414"}`,
                          transform: isActive ? "scale(1.22)" : "scale(1)",
                          transition: "border-color 0.55s ease, transform 0.55s cubic-bezier(0.34,1.56,0.64,1)",
                        }} />

                        {isActive && (
                          <div className="kz-pulse-ring" style={{
                            position: "absolute",
                            width: 10, height: 10,
                            borderRadius: "50%",
                          }} />
                        )}

                        <div
                          className={isActive ? "kz-dot-pop" : ""}
                          style={{
                            width: 10, height: 10,
                            borderRadius: "50%",
                            background: isActive ? "#fff" : isVisited ? "#383838" : "#1a1a1a",
                            boxShadow: isActive ? "0 0 16px 4px rgba(255,255,255,0.18)" : "none",
                            transition: "background 0.55s ease, box-shadow 0.55s ease",
                            position: "relative",
                            zIndex: 1,
                          }}
                        />
                      </div>

                      {!above && (
                        <div style={{
                          fontSize: 14,
                          fontWeight: 500,
                          letterSpacing: "0.2em",
                          color: isActive ? "#ffffff" : "#868686",
                          textTransform: "uppercase",
                          position: "absolute",
                          top: "calc(100% + 20px)",
                          whiteSpace: "nowrap",
                          transition: "color 0.55s ease",
                          fontFamily: "inherit",
                        }}>
                          {p.label}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── Textbox ── */}
          <div style={{
            width: "100%",
            maxWidth: 1000,
            padding: "0 24px",
            marginTop: 52,
          }}>
            <div style={{
              border: "1px solid #111",
              borderRadius: 1,
              padding: "28px 36px",
              minHeight: 150,
              position: "relative",
              background: "rgba(0,0,0,0.6)",
              backdropFilter: "blur(4px)",
            }}>
              {/* Top accent */}
              <div style={{
                position: "absolute",
                top: 0, left: "20%", right: "20%",
                height: 1,
                background: "linear-gradient(90deg, transparent, #282828, transparent)",
              }} />

              <div
                key={displayIndex}
                className={textVisible ? "kz-text-in" : "kz-text-out"}
              >
                <div style={{
                  fontSize: 14,
                  fontWeight: 500,
                  letterSpacing: "0.24em",
                  color: "#a6a6a6",
                  textTransform: "uppercase",
                  marginBottom: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontFamily: "inherit",
                }}>
                  <span style={{ display: "inline-block", width: 16, height: 1, background: "#a6a6a6" }} />
                  {phase.label}
                </div>

                <div style={{
                  fontSize: 36,
                  fontWeight: 500,
                  color: "#ececec",
                  marginBottom: 12,
                  lineHeight: 1.3,
                  fontFamily: "inherit",
                }}>
                  {phase.title}
                </div>

                <div style={{
                  fontSize: 18,
                  fontWeight: 300,
                  color: "#bfbfbf",
                  lineHeight: 1.9,
                  fontFamily: "inherit",
                }}>
                  {phase.body}
                </div>
              </div>
            </div>

            {/* Pips */}
            <div style={{
              display: "flex",
              justifyContent: "center",
              gap: 6,
              marginTop: 20,
            }}>
              {phases.map((_, i) => (
                <div
                  key={i}
                  onClick={() => goTo(i)}
                  style={{
                    height: 2,
                    width: i === current ? 24 : 4,
                    borderRadius: 2,
                    background: i === current ? "#484848" : "#141414",
                    transition: "width 0.45s ease, background 0.45s ease",
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
          </div>

          {/* Scroll hint */}
          <div style={{
            position: "absolute",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            pointerEvents: "none",
          }}>
            <div style={{
              fontSize: 9,
              letterSpacing: "0.2em",
              color: "#1c1c1c",
              textTransform: "uppercase",
              fontFamily: "inherit",
            }}>
              scroll
            </div>
            <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
              <rect x="1" y="1" width="12" height="18" rx="6" stroke="#1c1c1c" strokeWidth="1"/>
              <rect
                className="kz-scroll-hint"
                x="5.5" y="4" width="3" height="5" rx="1.5"
                fill="#282828"
              />
            </svg>
          </div>
        </div>
      </div>
    </>
  );
}
