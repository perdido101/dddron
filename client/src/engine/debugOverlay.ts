import { DEBUG_SAMPLE_FRAMES } from '@shared/constants';

import type { Physics } from './physics';

/** FPS / physics-cost / body-count readout. Toggled with the ~ key. */
export class DebugOverlay {
  private readonly element: HTMLElement;
  private visible = false;
  private frameSamples: number[] = [];
  private stepSamples: number[] = [];
  private extraLines: string[] = [];

  constructor(element: HTMLElement) {
    this.element = element;
    this.element.hidden = true;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.element.hidden = !this.visible;
  }

  /** Lines appended below the standard readout, refreshed every frame. */
  setExtraLines(lines: string[]): void {
    this.extraLines = lines;
  }

  update(frameDelta: number, physics: Physics): void {
    this.frameSamples.push(frameDelta);
    this.stepSamples.push(physics.stepMs);
    if (this.frameSamples.length > DEBUG_SAMPLE_FRAMES) {
      this.frameSamples.shift();
      this.stepSamples.shift();
    }
    if (!this.visible) return;

    const meanFrame = mean(this.frameSamples);
    const fps = meanFrame > 0 ? 1 / meanFrame : 0;
    const lines = [
      `fps          ${fps.toFixed(1)}  (${(meanFrame * 1000).toFixed(2)} ms)`,
      `physics      ${mean(this.stepSamples).toFixed(2)} ms  ×${physics.stepsLastFrame} steps`,
      `bodies       ${physics.bodyCount}   colliders ${physics.colliderCount}`,
      `interp alpha ${physics.alpha.toFixed(3)}`,
      ...this.extraLines,
    ];
    this.element.textContent = lines.join('\n');
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
