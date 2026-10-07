import { Easing, interpolate } from "remotion";

// 8 bars at 128 BPM is exactly 15 seconds. Every cue below is expressed in beats.
export const FPS = 30;
export const BPM = 128;
export const BEAT = (FPS * 60) / BPM;
export const BAR = BEAT * 4;
export const TOTAL = Math.round(BAR * 8);
export const beat = (n: number) => n * BEAT;

export const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0 -> 1 between two beat positions, clamped and eased. */
export const t = (frame: number, startBeat: number, lengthBeats: number, easing = ease) =>
  interpolate(frame, [beat(startBeat), beat(startBeat + lengthBeats)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });

export const C = {
  paper: "#f9fafb",
  ink: "#1b1e25",
  muted: "#626773",
  line: "#dfe2e8",
  blue: "#364cf5",
  navy: "#17233d",
  mint: "#8effd1",
  green: "#34876d",
  peach: "#ffc285",
};
export const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
export const MONO = '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace';
