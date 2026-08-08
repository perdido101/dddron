import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  AIR_CONTROL,
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  CEILING_BLOCK_EPSILON,
  COLOR_RUNNER,
  COLOR_RUNNER_HEAD,
  CONTROLLER_AUTOSTEP_HEIGHT,
  CONTROLLER_AUTOSTEP_MIN_WIDTH,
  CONTROLLER_MAX_SLOPE,
  CONTROLLER_MIN_SLIDE_SLOPE,
  CONTROLLER_OFFSET,
  CONTROLLER_SNAP_TO_GROUND,
  COYOTE_TIME,
  FACING_TURN_RATE,
  FOOT_OFFSET,
  GRAVITY,
  HEAD_OFFSET,
  HEAD_RADIUS,
  JUMP_BUFFER_TIME,
  JUMP_IMPULSE,
  MAX_FALL_SPEED,
  MOVE_EPSILON,
  PUSH_DECAY,
  RESPAWN_Y_THRESHOLD,
  RUNNER_MASS,
  RUNNER_SPAWN,
  RUN_ACCEL,
  RUN_BOB_AMPLITUDE,
  RUN_BOB_FREQUENCY,
  RUN_DECEL,
  RUN_LEAN_MAX,
  RUN_SPEED,
  SQUASH_FULL_IMPACT_SPEED,
  SQUASH_LAND_SCALE,
  SQUASH_RECOVER_TIME,
  SQUASH_WOBBLE_CYCLES,
  STICK_TO_GROUND_SPEED,
  STRETCH_JUMP_SCALE,
} from '@shared/constants';

import { InterpolatedTransform } from '../engine/interpolation';
import type { Physics } from '../engine/physics';

/**
 * Third-person runner.
 *
 * A Rapier kinematic character controller drives a capsule; velocity is
 * integrated here rather than by the solver, because a party-game runner wants
 * hand-authored acceleration curves, not rigid-body dynamics.
 */
export class Runner {
  /** Root of the visual rig, positioned at the capsule centre. */
  readonly object = new THREE.Group();

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  grounded = false;
  /** Eliminated runners stop simulating and vanish (phase 8 makes them gremlins). */
  alive = true;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly transform: InterpolatedTransform;

  /** Scales and leans about the feet; the root stays at the capsule centre. */
  private readonly pivot = new THREE.Group();
  private readonly figure = new THREE.Group();

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private facing = 0;
  private bobPhase = 0;
  private squashAmount = 0;
  private squashTimer = SQUASH_RECOVER_TIME;

  private readonly wish = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly leanAxis = new THREE.Vector3();
  private readonly lastMovement = new THREE.Vector3();
  /** External shoves (prop wash). Decays on its own; not pilot input. */
  private readonly push = new THREE.Vector3();
  /** Velocity the controller actually delivered, for lean, bob and facing. */
  private readonly realised = new THREE.Vector3();

  constructor(physics: Physics, scene: THREE.Scene) {
    const [spawnX, spawnY, spawnZ] = RUNNER_SPAWN;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawnX, spawnY, spawnZ),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
      this.body,
    );

    this.controller = physics.world.createCharacterController(CONTROLLER_OFFSET);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(CONTROLLER_MAX_SLOPE);
    this.controller.setMinSlopeSlideAngle(CONTROLLER_MIN_SLIDE_SLOPE);
    this.controller.enableAutostep(CONTROLLER_AUTOSTEP_HEIGHT, CONTROLLER_AUTOSTEP_MIN_WIDTH, true);
    this.controller.enableSnapToGround(CONTROLLER_SNAP_TO_GROUND);
    this.controller.setApplyImpulsesToDynamicBodies(true);

    this.position.set(spawnX, spawnY, spawnZ);
    this.transform = new InterpolatedTransform(this.position);

    this.buildVisual();
    scene.add(this.object);
  }

  /**
   * Chunky toy proportions: a stubby capsule under an oversized head. The
   * whole rig hangs off a pivot at the feet so squash never floats the body.
   */
  private buildVisual(): void {
    this.pivot.position.y = -FOOT_OFFSET;
    this.figure.position.y = FOOT_OFFSET;
    this.pivot.add(this.figure);
    this.object.add(this.pivot);

    const bodyMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2),
      new THREE.MeshLambertMaterial({ color: COLOR_RUNNER }),
    );
    bodyMesh.castShadow = true;
    this.figure.add(bodyMesh);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_RADIUS),
      new THREE.MeshLambertMaterial({ color: COLOR_RUNNER_HEAD }),
    );
    head.position.y = HEAD_OFFSET;
    head.castShadow = true;
    this.figure.add(head);

    // Facing marker — a stand-in for the sticker face landing in phase 10.
    const snout = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_RADIUS, HEAD_RADIUS / 2, HEAD_RADIUS / 2),
      new THREE.MeshLambertMaterial({ color: COLOR_RUNNER }),
    );
    snout.position.set(0, HEAD_OFFSET, -HEAD_RADIUS);
    this.figure.add(snout);
  }

  /**
   * Take an external force for one step — prop wash, and later throwables.
   * Never lethal; it only displaces (brief, phase 2).
   */
  applyPush(force: THREE.Vector3, dt: number): void {
    this.push.addScaledVector(force, dt / RUNNER_MASS);
  }

  /** Caught in a detonation. Never called by anything but the blast query. */
  eliminate(): void {
    this.alive = false;
    this.object.visible = false;
    this.velocity.set(0, 0, 0);
    this.push.set(0, 0, 0);
  }

  /** Latch a jump press. Buffered so it survives the gap between fixed steps. */
  queueJump(): void {
    this.jumpBufferTimer = JUMP_BUFFER_TIME;
  }

  respawn(): void {
    const [x, y, z] = RUNNER_SPAWN;
    this.alive = true;
    this.object.visible = true;
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.push.set(0, 0, 0);
    this.body.setTranslation({ x, y, z }, true);
    this.transform.teleport(this.position);
  }

  /**
   * @param moveInput x = strafe, y = forward, each in [-1, 1].
   * @param cameraYaw heading the movement is relative to.
   */
  fixedUpdate(dt: number, moveInput: THREE.Vector2, cameraYaw: number): void {
    if (!this.alive) return;
    this.integrateHorizontal(dt, moveInput, cameraYaw);
    this.integrateVertical(dt);

    // External pushes bleed off on their own and are additive to pilot intent,
    // so being shoved never takes control away, it just moves you.
    this.push.multiplyScalar(Math.exp(-PUSH_DECAY * dt));
    this.desired.copy(this.velocity).add(this.push).multiplyScalar(dt);
    this.controller.computeColliderMovement(this.collider, this.desired);
    const movement = this.controller.computedMovement();

    const wasGrounded = this.grounded;
    const impactSpeed = -this.velocity.y;
    this.grounded = this.controller.computedGrounded();

    // Head hit the ceiling: kill the climb so we do not hover under it.
    if (this.velocity.y > 0 && movement.y < this.desired.y - CEILING_BLOCK_EPSILON) {
      this.velocity.y = 0;
    }

    // Intent velocity (this.velocity) is kept separate from realised velocity.
    // Feeding the controller's output back into the intent looks tempting -- it
    // bleeds speed when you run into a wall -- but on a slope the controller
    // legitimately trades horizontal travel for climb, and feeding that back
    // reads as "blocked", decays the input, and stalls the runner partway up
    // every ramp. Cosmetics use the realised value; physics uses the intent.
    this.lastMovement.set(movement.x, movement.y, movement.z);
    if (dt > 0) this.realised.copy(this.lastMovement).divideScalar(dt);
    this.position.x += movement.x;
    this.position.y += movement.y;
    this.position.z += movement.z;
    this.body.setNextKinematicTranslation(this.position);

    if (!wasGrounded && this.grounded && impactSpeed > 0) {
      const strength = Math.min(impactSpeed / SQUASH_FULL_IMPACT_SPEED, 1);
      this.applySquash((SQUASH_LAND_SCALE - 1) * strength);
    }

    if (this.position.y < RESPAWN_Y_THRESHOLD) this.respawn();

    this.transform.push(this.position);
  }

  private integrateHorizontal(dt: number, moveInput: THREE.Vector2, cameraYaw: number): void {
    // Camera-relative: yaw 0 looks down -Z.
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    this.wish
      .set(-sin * moveInput.y + cos * moveInput.x, 0, -cos * moveInput.y - sin * moveInput.x);
    if (this.wish.lengthSq() > 1) this.wish.normalize();

    const hasInput = this.wish.lengthSq() > 0;
    const control = this.grounded ? 1 : AIR_CONTROL;
    const rate = (hasInput ? RUN_ACCEL : RUN_DECEL) * control;

    const targetX = this.wish.x * RUN_SPEED;
    const targetZ = this.wish.z * RUN_SPEED;
    const deltaX = targetX - this.velocity.x;
    const deltaZ = targetZ - this.velocity.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance > 0) {
      const step = Math.min(distance, rate * dt) / distance;
      this.velocity.x += deltaX * step;
      this.velocity.z += deltaZ * step;
    }
  }

  private integrateVertical(dt: number): void {
    this.coyoteTimer = this.grounded ? COYOTE_TIME : Math.max(this.coyoteTimer - dt, 0);
    this.jumpBufferTimer = Math.max(this.jumpBufferTimer - dt, 0);

    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.velocity.y = JUMP_IMPULSE;
      this.jumpBufferTimer = 0;
      this.coyoteTimer = 0;
      this.grounded = false;
      this.applySquash(STRETCH_JUMP_SCALE - 1);
      return;
    }

    if (this.grounded && this.velocity.y <= 0) {
      this.velocity.y = -STICK_TO_GROUND_SPEED;
      return;
    }

    this.velocity.y = Math.max(this.velocity.y + GRAVITY * dt, -MAX_FALL_SPEED);
  }

  private applySquash(amount: number): void {
    this.squashAmount = amount;
    this.squashTimer = 0;
  }

  /** Interpolate to the render time and drive the cosmetic rig. */
  render(alpha: number, frameDelta: number): void {
    this.transform.readPosition(this.object.position, alpha);

    const speed = Math.hypot(this.realised.x, this.realised.z);
    const speedRatio = Math.min(speed / RUN_SPEED, 1);

    if (speed > MOVE_EPSILON) {
      const target = Math.atan2(-this.realised.x, -this.realised.z);
      this.facing = turnToward(this.facing, target, FACING_TURN_RATE * frameDelta);
    }
    this.figure.rotation.y = this.facing;

    this.squashTimer = Math.min(this.squashTimer + frameDelta, SQUASH_RECOVER_TIME);
    // Decaying wobble on a normalised clock: the (1 - u)^2 envelope reaches
    // exactly zero at SQUASH_RECOVER_TIME, so the rig never pops back to
    // neutral part-way through a swing.
    const u = this.squashTimer / SQUASH_RECOVER_TIME;
    const envelope = (1 - u) * (1 - u);
    const wobble = envelope * Math.cos(2 * Math.PI * SQUASH_WOBBLE_CYCLES * u);
    const scaleY = 1 + this.squashAmount * wobble;
    const scaleXZ = 1 / Math.sqrt(scaleY);
    this.pivot.scale.set(scaleXZ, scaleY, scaleXZ);

    if (speed > MOVE_EPSILON) {
      this.leanAxis.set(this.realised.z, 0, -this.realised.x).normalize();
      this.pivot.quaternion.setFromAxisAngle(this.leanAxis, RUN_LEAN_MAX * speedRatio);
    } else {
      this.pivot.quaternion.identity();
    }

    if (this.grounded) {
      this.bobPhase += frameDelta * RUN_BOB_FREQUENCY * speedRatio * Math.PI * 2;
      this.figure.position.y = FOOT_OFFSET + Math.abs(Math.sin(this.bobPhase)) * RUN_BOB_AMPLITUDE * speedRatio;
    } else {
      this.figure.position.y = FOOT_OFFSET;
    }
  }

  get characterCollider(): RAPIER.Collider {
    return this.collider;
  }

  debugLines(): string[] {
    return [
      `runner pos   ${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}`,
      `runner speed ${Math.hypot(this.realised.x, this.realised.z).toFixed(2)} m/s` +
        ` (intent ${Math.hypot(this.velocity.x, this.velocity.z).toFixed(2)})  vy ${this.velocity.y.toFixed(2)}`,
      `grounded     ${this.grounded ? 'yes' : 'no'}   coyote ${this.coyoteTimer.toFixed(2)}`,
      `squash scaleY ${this.pivot.scale.y.toFixed(3)}  (land ${SQUASH_LAND_SCALE}, jump ${STRETCH_JUMP_SCALE})`,
      `move want    ${fmt(this.desired)}`,
      `move got     ${fmt(this.lastMovement)}`,
    ];
  }
}

function fmt(v: THREE.Vector3): string {
  return `${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}`;
}

/** Shortest-arc turn from `current` toward `target`, capped at `maxDelta`. */
function turnToward(current: number, target: number, maxDelta: number): number {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + THREE.MathUtils.clamp(delta, -maxDelta, maxDelta);
}
