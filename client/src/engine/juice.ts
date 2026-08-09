import * as THREE from 'three';

import {
  HITSTOP_SWAT,
  SHAKE_DECAY,
  SHAKE_DETONATION,
  SHAKE_FREQUENCY,
  SHAKE_KNOCKDOWN,
  SHAKE_MAX_OFFSET,
  PUNCH_EMP,
  PUNCH_RECOVER,
} from '@shared/constants';

/**
 * Screen shake, hit stop and camera punch.
 *
 * All of it is applied to the camera AFTER the rig has positioned it, so no
 * gameplay code has to know juice exists and nothing here can move a body.
 * Hit stop is the one exception that touches timing: it scales the frame delta
 * for a few milliseconds, which is what makes a connecting swat feel solid.
 */
export class Juice {
  private shake = 0;
  private punch = 0;
  private hitstop = 0;
  private clock = 0;

  private readonly offset = new THREE.Vector3();

  /** A detonation: the biggest shake in the game. */
  detonation(distance: number, radius: number): void {
    // Falls off with distance, so a blast across the arena is a rumble and one
    // at your feet is a wallop.
    const closeness = Math.max(0, 1 - distance / (radius * SHAKE_FALLOFF_RANGE));
    this.shake = Math.max(this.shake, SHAKE_DETONATION * closeness);
  }

  knockdown(): void {
    this.shake = Math.max(this.shake, SHAKE_KNOCKDOWN);
  }

  /** A swat that connects. Brief freeze, which reads as impact. */
  swatConnected(): void {
    this.hitstop = HITSTOP_SWAT;
  }

  /** The EMP firing: a camera punch rather than a shake. */
  empFired(): void {
    this.punch = PUNCH_EMP;
  }

  /**
   * @returns the frame delta the rest of the game should use — scaled to zero
   * during hit stop, so the world holds still for a beat.
   */
  consumeHitstop(frameDelta: number): number {
    if (this.hitstop <= 0) return frameDelta;
    this.hitstop -= frameDelta;
    return frameDelta * HITSTOP_TIME_SCALE;
  }

  /** Apply to the camera after the rig has placed it. */
  apply(camera: THREE.Camera, frameDelta: number, baseFov: number): void {
    this.clock += frameDelta;
    this.shake = Math.max(0, this.shake - SHAKE_DECAY * frameDelta);
    this.punch = Math.max(0, this.punch - PUNCH_RECOVER * frameDelta);

    if (this.shake > 0) {
      const amount = Math.min(this.shake, SHAKE_MAX_OFFSET);
      this.offset.set(
        Math.sin(this.clock * SHAKE_FREQUENCY) * amount,
        Math.sin(this.clock * SHAKE_FREQUENCY * 1.37 + 1.1) * amount,
        0,
      );
      this.offset.applyQuaternion(camera.quaternion);
      camera.position.add(this.offset);
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      const wanted = baseFov + this.punch;
      if (Math.abs(camera.fov - wanted) > 0.01) {
        camera.fov = wanted;
        camera.updateProjectionMatrix();
      }
    }
  }
}

/** Blast shake reaches this many detonation-radii out. */
const SHAKE_FALLOFF_RANGE = 4;
/** Time runs at this rate during hit stop. */
const HITSTOP_TIME_SCALE = 0.05;
