import RAPIER from '@dimforge/rapier3d-compat';

import {
  FIXED_TIMESTEP,
  GRAVITY,
  MAX_FRAME_DELTA,
  MAX_STEPS_PER_FRAME,
} from '@shared/constants';

export type FixedStepListener = (dt: number) => void;

/**
 * Fixed-timestep Rapier world.
 *
 * The world always advances in whole FIXED_TIMESTEP increments. Whatever time
 * is left over is exposed as `alpha`, and renderers use it to interpolate
 * between the previous and current physics transforms, so the visible motion
 * is smooth even though the simulation is quantised.
 */
export class Physics {
  readonly world: RAPIER.World;

  /** Fraction of a step that has accumulated but not yet been simulated. */
  alpha = 0;
  /** Wall-clock cost of the most recent frame's stepping, in milliseconds. */
  stepMs = 0;
  /** Steps simulated during the most recent frame. */
  stepsLastFrame = 0;

  private accumulator = 0;
  private readonly preStep: FixedStepListener[] = [];
  private readonly postStep: FixedStepListener[] = [];

  private constructor(world: RAPIER.World) {
    this.world = world;
    this.world.timestep = FIXED_TIMESTEP;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    return new Physics(world);
  }

  /** Runs once per fixed step, before the world steps: apply forces and inputs. */
  onFixedStep(listener: FixedStepListener): void {
    this.preStep.push(listener);
  }

  /** Runs once per fixed step, after the world steps: sample body transforms. */
  onFixedPostStep(listener: FixedStepListener): void {
    this.postStep.push(listener);
  }

  /**
   * Consume a frame's worth of real time.
   *
   * Deltas larger than MAX_FRAME_DELTA are discarded outright rather than
   * simulated — that is the backgrounded-tab case, and replaying 30 s of
   * physics on refocus is both pointless and a guaranteed hitch. If the frame
   * still needs more than MAX_STEPS_PER_FRAME steps, the remaining debt is
   * dropped so the simulation cannot spiral.
   */
  advance(frameDelta: number): void {
    this.accumulator += Math.min(frameDelta, MAX_FRAME_DELTA);

    const startedAt = performance.now();
    let steps = 0;
    while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_STEPS_PER_FRAME) {
      for (const listener of this.preStep) listener(FIXED_TIMESTEP);
      this.world.step();
      for (const listener of this.postStep) listener(FIXED_TIMESTEP);
      this.accumulator -= FIXED_TIMESTEP;
      steps += 1;
    }

    if (this.accumulator >= FIXED_TIMESTEP) this.accumulator = 0;

    this.stepsLastFrame = steps;
    this.stepMs = steps > 0 ? performance.now() - startedAt : 0;
    this.alpha = this.accumulator / FIXED_TIMESTEP;
  }

  /** Drop any pending time. Used when the tab regains focus. */
  resetAccumulator(): void {
    this.accumulator = 0;
    this.alpha = 0;
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }

  get colliderCount(): number {
    return this.world.colliders.len();
  }
}
