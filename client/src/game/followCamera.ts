import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  CAMERA_COLLISION_RADIUS,
  CAMERA_DISTANCE,
  CAMERA_LAG,
  CAMERA_MIN_DISTANCE,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_PITCH_START,
  CAMERA_TARGET_HEIGHT,
  CAMERA_UNBLOCK_SPEED,
  FOOT_OFFSET,
  MOUSE_SENSITIVITY,
} from '@shared/constants';

import type { Physics } from '../engine/physics';

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Third-person follow rig.
 *
 * The look-at point trails the runner slightly, and the boom shortens when
 * geometry gets between the camera and that point — snapping in hard so the
 * wall never crosses the near plane, easing back out once it clears.
 */
export class FollowCamera {
  yaw = 0;
  pitch = CAMERA_PITCH_START;

  private readonly smoothedTarget = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly probe = new RAPIER.Ball(CAMERA_COLLISION_RADIUS);
  private distance = CAMERA_DISTANCE;
  private initialised = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly physics: Physics,
  ) {}

  /** Feed raw pointer-lock deltas. */
  look(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * MOUSE_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + deltaY * MOUSE_SENSITIVITY,
      CAMERA_PITCH_MIN,
      CAMERA_PITCH_MAX,
    );
  }

  /**
   * @param anchor the runner's interpolated capsule centre.
   * @param exclude the runner's own collider, which must not block the boom.
   */
  update(frameDelta: number, anchor: THREE.Vector3, exclude: RAPIER.Collider): void {
    this.target.set(anchor.x, anchor.y - FOOT_OFFSET + CAMERA_TARGET_HEIGHT, anchor.z);
    if (!this.initialised) {
      this.smoothedTarget.copy(this.target);
      this.initialised = true;
    } else {
      // Frame-rate independent exponential smoothing.
      const blend = 1 - Math.exp(-frameDelta / CAMERA_LAG);
      this.smoothedTarget.lerp(this.target, blend);
    }

    const cosPitch = Math.cos(this.pitch);
    this.offset.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    );

    const wanted = this.resolveDistance(exclude);
    if (wanted < this.distance) {
      this.distance = wanted;
    } else {
      this.distance = Math.min(wanted, this.distance + CAMERA_UNBLOCK_SPEED * frameDelta);
    }

    this.camera.position.copy(this.smoothedTarget).addScaledVector(this.offset, this.distance);
    this.camera.lookAt(this.smoothedTarget);
  }

  /** Sphere-cast from the look-at point out along the boom. */
  private resolveDistance(exclude: RAPIER.Collider): number {
    const travel = {
      x: this.offset.x * CAMERA_DISTANCE,
      y: this.offset.y * CAMERA_DISTANCE,
      z: this.offset.z * CAMERA_DISTANCE,
    };
    const hit = this.physics.world.castShape(
      this.smoothedTarget,
      IDENTITY_ROTATION,
      travel,
      this.probe,
      0,
      1,
      true,
      undefined,
      undefined,
      exclude,
    );
    if (!hit) return CAMERA_DISTANCE;
    return Math.max(CAMERA_MIN_DISTANCE, hit.time_of_impact * CAMERA_DISTANCE);
  }

  /** Heading movement input is resolved against. */
  get heading(): number {
    return this.yaw;
  }

  /** Current boom length. Shorter than CAMERA_DISTANCE means geometry is close. */
  get boomLength(): number {
    return this.distance;
  }
}
