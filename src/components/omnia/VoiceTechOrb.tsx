import React, { useEffect, useRef } from "react";
import type { RealtimeVoiceState } from "@/hooks/useRealtimeVoice";

interface VoiceTechOrbProps {
  state: RealtimeVoiceState;
  /** 0..1 mic amplitude, used to make the cloud breathe while listening. */
  micLevel?: number;
  /** Rendered size in CSS pixels (square). */
  size?: number;
  /**
   * Dot palette. "auto" (default) follows the app theme (white on dark, blue
   * on light). Force "dark"/"light" when the orb sits on a surface whose
   * background is fixed regardless of theme — e.g. the always-dark voice
   * preview card on the landing page, which must always use the white dots.
   */
  appearance?: "auto" | "dark" | "light";
}

/** How many little "neuron" balls make up the sphere. */
const NEURONS = 1100;

interface Neuron {
  /** Base position on the unit sphere. */
  x: number;
  y: number;
  z: number;
  /** Per-ball phase offsets so the bob/drift never looks synchronized. */
  bobPhase: number;
  driftPhase: number;
  driftAxis: number;
  size: number;
}

/**
 * A cloud of tiny "neurons" arranged on a sphere. Each ball bobs gently
 * in and out, the whole sphere rotates slowly and glows. While the user talks
 * the sphere pulses and the balls drift around a little more energetically.
 * Dots are WHITE in dark mode and BLUE in light mode (read live each frame);
 * only motion/brightness react to the voice state.
 */
export default function VoiceTechOrb({ state, micLevel = 0, size = 320, appearance = "auto" }: VoiceTechOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<RealtimeVoiceState>(state);
  const micRef = useRef(0);
  const appearanceRef = useRef(appearance);
  // Smoothed values so transitions never pop.
  const intensityRef = useRef(0.4);
  const spinRef = useRef(0.18);
  const activityRef = useRef(0);
  const rotRef = useRef(0);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { micRef.current = micLevel; }, [micLevel]);
  useEffect(() => { appearanceRef.current = appearance; }, [appearance]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Evenly distribute neurons on the sphere (Fibonacci lattice).
    const neurons: Neuron[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NEURONS; i++) {
      const y = 1 - (i / (NEURONS - 1)) * 2; // 1 .. -1
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = i * golden;
      neurons.push({
        x: Math.cos(phi) * radius,
        y,
        z: Math.sin(phi) * radius,
        bobPhase: Math.random() * Math.PI * 2,
        driftPhase: Math.random() * Math.PI * 2,
        driftAxis: Math.random() * Math.PI * 2,
        size: 0.8 + Math.random() * 1.1,
      });
    }

    const cx = size / 2;
    const cy = size / 2;
    const R = size * 0.34;

    let raf = 0;
    let last = performance.now();

    const targetFor = (st: RealtimeVoiceState): { intensity: number; spin: number; activity: number } => {
      switch (st) {
        case "speaking": return { intensity: 1, spin: 0.34, activity: 1 };
        case "thinking": return { intensity: 0.78, spin: 0.6, activity: 0.55 };
        case "listening": return { intensity: 0.72, spin: 0.22, activity: 0.45 };
        case "connecting": return { intensity: 0.55, spin: 0.4, activity: 0.3 };
        case "error": return { intensity: 0.3, spin: 0.1, activity: 0.05 };
        default: return { intensity: 0.45, spin: 0.16, activity: 0.12 }; // idle
      }
    };

    const render = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const tsec = now / 1000;

      const st = stateRef.current;
      const mic = micRef.current;
      const target = targetFor(st);

      // Ease everything toward its target so state changes glide.
      intensityRef.current += (target.intensity - intensityRef.current) * Math.min(dt * 4, 1);
      spinRef.current += (target.spin - spinRef.current) * Math.min(dt * 3, 1);
      const liveActivity = st === "listening" ? Math.max(target.activity, mic) : target.activity;
      activityRef.current += (liveActivity - activityRef.current) * Math.min(dt * 5, 1);

      const intensity = intensityRef.current;
      const activity = activityRef.current;
      rotRef.current += spinRef.current * dt;
      const rot = rotRef.current;

      // Whole-sphere pulse: gentle idle breath; stronger when talking.
      let pulse = 1 + Math.sin(tsec * 1.4) * 0.015;
      if (st === "speaking") pulse = 1 + Math.sin(tsec * 6.5) * 0.05;
      else if (st === "listening") pulse = 1 + mic * 0.18;
      const Reff = R * pulse;

      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const tilt = 0.32; // fixed slight tilt so we see it as a globe
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);

      // Theme-aware, read live each frame so the orb flips instantly when the
      // user toggles light/dark. Dark mode: WHITE dots with additive "lighter"
      // blending (glow). Light mode: BLUE dots with "multiply" so overlapping
      // dots accumulate into a dense, saturated cloud (additive is invisible on
      // white, and plain source-over lets the faint back dots wash out — which
      // made the orb read sparse in light mode).
      const appr = appearanceRef.current;
      const isDark = appr === "dark"
        ? true
        : appr === "light"
          ? false
          : document.documentElement.classList.contains("dark");
      const dotRgb = isDark ? "255,255,255" : "37,99,235";

      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = isDark ? "lighter" : "multiply";

      for (let k = 0; k < neurons.length; k++) {
        const n = neurons[k];

        // Each ball bobs in/out along its own radius, and drifts a touch.
        const bob = Math.sin(tsec * 1.6 + n.bobPhase) * (0.018 + activity * 0.05);
        const drift = (0.01 + activity * 0.06) * Math.sin(tsec * 1.1 + n.driftPhase);
        const da = n.driftAxis;
        let bx = n.x + Math.cos(da) * drift;
        let by = n.y + Math.sin(da) * drift;
        let bz = n.z + Math.cos(da * 1.7) * drift;
        // Re-normalize onto the (bobbed) sphere so the ball stays on the shell.
        const len = Math.hypot(bx, by, bz) || 1;
        const rr = 1 + bob;
        bx = (bx / len) * rr;
        by = (by / len) * rr;
        bz = (bz / len) * rr;

        // Spin around vertical axis, then tilt forward.
        const x1 = bx * cosR + bz * sinR;
        const z1 = -bx * sinR + bz * cosR;
        const y1 = by;
        const y2 = y1 * cosT - z1 * sinT;
        const z2 = y1 * sinT + z1 * cosT;

        const px = cx + x1 * Reff;
        const py = cy - y2 * Reff;

        // Depth shade: front balls bright, back balls faint. Light mode keeps a
        // higher floor so back-of-sphere blue dots don't wash out to white.
        const depth = (z2 + 1) / 2; // 0 back .. 1 front
        const aFloor = isDark ? 0.18 : 0.34;
        const aSpan = isDark ? 0.82 : 0.66;
        let a = (aFloor + depth * aSpan) * intensity;
        if (a > 1) a = 1;

        const r = n.size * (0.5 + depth * 0.55);

        ctx.fillStyle = `rgba(${dotRgb},${a})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Faint overall glow behind the cloud. Only in dark mode — the additive
      // white glow is what makes the orb read as luminous; on a light backdrop
      // a glow just muddies the crisp black dots, so we skip it.
      if (isDark) {
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Reff * 1.15);
        grad.addColorStop(0, `rgba(255,255,255,${0.06 * intensity})`);
        grad.addColorStop(0.55, `rgba(255,255,255,${0.03 * intensity})`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, Reff * 1.15, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
    />
  );
}
