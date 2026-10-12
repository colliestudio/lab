/** Turns a stream of audio levels (RMS 0..1) into a steady speaking flag: hysteresis plus a short hold so word gaps don't flicker. */
export class SpeakingDetector {
  private speaking = false;
  private last = 0;
  constructor(
    private on = 0.02,
    private off = 0.012,
    private holdMs = 300,
  ) {}
  update(level: number, now: number): boolean {
    if (level >= (this.speaking ? this.off : this.on)) {
      this.speaking = true;
      this.last = now;
    } else if (this.speaking && now - this.last > this.holdMs) {
      this.speaking = false;
    }
    return this.speaking;
  }
}

/**
 * Proximity: full volume near me, fading to a floor with distance (world units between cursors).
 * Never fully silent: you can still hear someone across the table, just quieter.
 */
export function proximityGain(distance: number, near = 600, far = 3000, floor = 0.15): number {
  if (distance <= near) return 1;
  if (distance >= far) return floor;
  return 1 - ((distance - near) / (far - near)) * (1 - floor);
}
