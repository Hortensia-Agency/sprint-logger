/**
 * Springs in Apple's two-parameter form, for Reanimated. A port of Sprint's
 * lib/motion/spring.ts (the web widget carries the same port), held to it by
 * Sprint's tests/qa-widget-motion.test.ts. No imports, so that test can load
 * this file as is.
 */

/** Reanimated's withSpring config for a damping ratio and a response in seconds. */
export function appleSpring(dampingRatio: number, response: number, velocity = 0) {
  "worklet";
  return {
    mass: 1,
    stiffness: ((2 * Math.PI) / response) ** 2,
    damping: (4 * Math.PI * dampingRatio) / response,
    velocity,
  };
}

/** Where a flick at `v` px/s comes to rest (Apple's deceleration projection). */
export function project(v: number, decelerationRate = 0.998): number {
  "worklet";
  return ((v / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Past a bound the element follows the finger less and less. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** The bubble's spring: no overshoot unless a flick preceded it. */
export const FAB_RESPONSE = 0.35;
/** The sheet's spring. */
export const SHEET_RESPONSE = 0.35;
/** A flick faster than this, px/s, can't throw the bubble across the screen. */
export const MAX_FLICK = 4000;
