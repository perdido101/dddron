import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  AIR_CONTROL,
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  CARRY_SPEED,
  CEILING_BLOCK_EPSILON,
  COLOR_RUNNER,
  RUNNER_COLORWAYS,
  SWAT_ANIM_TIME,
  COLOR_RUNNER_HEAD,
  CORE_DROP_PUSH,
  CONTROLLER_AUTOSTEP_HEIGHT,
  CONTROLLER_AUTOSTEP_MIN_WIDTH,
  CONTROLLER_MAX_SLOPE,
  CONTROLLER_MIN_SLIDE_SLOPE,
  CONTROLLER_OFFSET,
  CONTROLLER_SNAP_TO_GROUND,
  COYOTE_TIME,
  FACING_TURN_RATE,
  HEAD_TURN_EASE,
  HEAD_YAW_MAX,
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

import { addRimLight } from '../engine/assets';
import { InterpolatedTransform } from '../engine/interpolation';
import type { Character } from './character';
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
  /** Carrying a power core: slower, and no jumping (brief, phase 4). */
  carrying = false;
  /**
   * Whether this runner is holding the interact key. The player's is set from
   * input; a bot's is set by its brain. The objective reads it off the runner
   * so it does not have to know which is which.
   */
  interacting = false;
  /** Holding a throwable prop: hands read as full, like carrying a core. */
  handsFull = false;

  private swatLeft = false;
  /** Seconds the fallen body remains visible after an elimination. */
  private deathLinger = 0;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly transform: InterpolatedTransform;

  /** Scales and leans about the feet; the root stays at the capsule centre. */
  private readonly pivot = new THREE.Group();
  private readonly figure = new THREE.Group();
  /** Shared by the body and the facing marker, so a colourway tints both. */
  private readonly bodyMaterial = (() => {
    const material = new THREE.MeshLambertMaterial({ color: COLOR_RUNNER });
    addRimLight(material);
    return material;
  })();
  /** The capsule stand-in, hidden once the real character model arrives. */
  private readonly primitives = new THREE.Group();
  private character: Character | null = null;
  private colorway = COLOR_RUNNER;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private facing = 0;
  /** Eased head yaw relative to the body, in radians. */
  private headYaw = 0;
  private bobPhase = 0;
  private squashAmount = 0;
  private squashTimer = SQUASH_RECOVER_TIME;

  private readonly wish = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly leanAxis = new THREE.Vector3();
  private readonly lastMovement = new THREE.Vector3();
  /** External shoves (prop wash). Decays on its own; not pilot input. */
  private readonly push = new THREE.Vector3();
  /** Set by any external shove; the objective reads it to drop a carried core. */
  private shoved = false;
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
      this.bodyMaterial,
    );
    bodyMesh.castShadow = true;
    this.primitives.add(bodyMesh);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_RADIUS),
      new THREE.MeshLambertMaterial({ color: COLOR_RUNNER_HEAD }),
    );
    head.position.y = HEAD_OFFSET;
    head.castShadow = true;
    this.primitives.add(head);

    // Facing marker, so the primitive body still reads a direction.
    const snout = new THREE.Mesh(
      new THREE.BoxGeometry(HEAD_RADIUS, HEAD_RADIUS / 2, HEAD_RADIUS / 2),
      this.bodyMaterial,
    );
    snout.position.set(0, HEAD_OFFSET, -HEAD_RADIUS);
    this.primitives.add(snout);
    this.figure.add(this.primitives);
  }

  /**
   * Swap the primitive body for the animated Kenney character.
   *
   * Called after the model loads, which is deliberately after the game has
   * already started: the arena is playable from the first frame and the body
   * upgrades in place. If the load failed the primitives simply stay.
   */
  attachCharacter(character: Character): void {
    this.character = character;
    // The model stands on its own origin; the figure's origin is the capsule's
    // centre, so drop it by half the capsule to put its feet on the ground.
    character.object.position.y = -FOOT_OFFSET;
    this.figure.add(character.object);
    this.primitives.visible = false;
    character.setColorway(this.colorway);
  }

  /**
   * Wear one of the six colourways.
   *
   * The server hands the index out, so a player is the same colour on every
   * screen including their own — seeing yourself in a different colour to
   * everyone else's view of you makes callouts useless.
   */
  setColorway(index: number): void {
    this.colorway = RUNNER_COLORWAYS[index % RUNNER_COLORWAYS.length] ?? COLOR_RUNNER;
    this.bodyMaterial.color.setHex(this.colorway);
    this.character?.setColorway(this.colorway);
  }

  /**
   * Take an external force for one step — prop wash, and later throwables.
   * Never lethal; it only displaces (brief, phase 2).
   */
  applyPush(force: THREE.Vector3, dt: number): void {
    this.push.addScaledVector(force, dt / RUNNER_MASS);
    // Only a real blast knocks a carried core loose. Without this threshold the
    // faintest brush at the very edge of the wash counts, and a core can never
    // be carried anywhere while the drone is on the same side of the arena.
    if (force.length() >= CORE_DROP_PUSH) this.shoved = true;
  }

  /**
   * Take this body out of play without destroying it.
   *
   * Used by the solo bot pool when the count drops: Rapier colliders are
   * awkward to remove mid-session, and a parked body under the floor collides
   * with nothing and is drawn nowhere.
   */
  park(): void {
    this.object.visible = false;
    this.alive = false;
    this.interacting = false;
    this.moveTo(PARKED[0], PARKED[1], PARKED[2]);
  }

  unpark(): void {
    if (this.object.visible) return;
    this.object.visible = true;
    this.respawn();
  }

  /** Play the melee swing. Cosmetic only — the swat's reach is Hazards' call. */
  playSwat(): void {
    // Alternate arms: the second swing of a flurry looking identical to the
    // first is the kind of detail that makes spam feel like animation reuse.
    this.character?.playOnce(this.swatLeft ? 'attack-melee-left' : 'attack-melee-right', SWAT_ANIM_TIME);
    this.swatLeft = !this.swatLeft;
  }

  /** Hurl whatever both hands were holding. Cosmetic, like the swat. */
  playThrow(): void {
    this.character?.playOnce('holding-both-shoot', THROW_ANIM_TIME);
  }

  /** A little celebration or defeat, e.g. on an insert or at round end. */
  playEmote(win: boolean): void {
    if (!this.alive) return;
    this.character?.playOnce(win ? 'emote-yes' : 'emote-no', EMOTE_TIME);
  }

  /** True once per shove. Reading it clears the flag. */
  consumeShoved(): boolean {
    const was = this.shoved;
    this.shoved = false;
    return was;
  }

  /** Horizontal speed the controller actually delivered. */
  get realisedSpeed(): number {
    return Math.hypot(this.realised.x, this.realised.z);
  }

  /** Horizontal speed the player is ASKING for, ignoring external shoves. */
  get intentSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Caught in a detonation. Never called by anything but the blast query. */
  eliminate(): void {
    this.alive = false;
    // The body stays for a beat playing the death clip, THEN vanishes — with
    // an instant hide the pack's die animation existed but no player had ever
    // seen it, and a teammate winking out of existence reads as a bug, not a
    // knockout.
    this.deathLinger = DEATH_LINGER;
    this.velocity.set(0, 0, 0);
    this.push.set(0, 0, 0);
  }

  /** Latch a jump press. Buffered so it survives the gap between fixed steps. */
  queueJump(): void {
    this.jumpBufferTimer = JUMP_BUFFER_TIME;
  }

  respawn(): void {
    this.alive = true;
    this.deathLinger = 0;
    this.object.visible = true;
    this.character?.reset();
    this.carrying = false;
    this.moveTo(RUNNER_SPAWN[0], RUNNER_SPAWN[1], RUNNER_SPAWN[2]);
  }

  /**
   * Put the body somewhere without simulating the journey.
   *
   * Movement is client-authoritative (sacred constraint 5), so this is a
   * legitimate local operation: the server relays wherever we say we are.
   * Velocity is cleared so the runner does not arrive already sprinting.
   */
  moveTo(x: number, y: number, z: number): void {
    this.shoved = false;
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

    const speed = this.carrying ? CARRY_SPEED : RUN_SPEED;
    const targetX = this.wish.x * speed;
    const targetZ = this.wish.z * speed;
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

    // Carrying a core means no jump at all — the core has to travel the long way.
    if (this.carrying) this.jumpBufferTimer = 0;

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

  /**
   * Interpolate to the render time and drive the cosmetic rig.
   *
   * @param interacting whether the interact key is held, for the pick-up clip.
   * @param lookYaw where the player is looking; the head turns to match.
   */
  render(alpha: number, frameDelta: number, interacting = false, lookYaw = 0): void {
    this.transform.readPosition(this.object.position, alpha);

    // The lingering corpse: visible while the death clip plays, then gone.
    if (!this.alive && this.deathLinger > 0) {
      this.deathLinger -= frameDelta;
      if (this.deathLinger <= 0) this.object.visible = false;
    }

    const speed = Math.hypot(this.realised.x, this.realised.z);

    this.character?.update(frameDelta, {
      speed,
      grounded: this.grounded,
      // A throwable in hand reads the same as a core: both hands are full.
      carrying: this.carrying || this.handsFull,
      alive: this.alive,
      interacting,
    });
    const speedRatio = Math.min(speed / RUN_SPEED, 1);

    // Body and head are steered separately, and the BODY does the work.
    //
    // Running, it points where it is going. Standing still, it comes round to
    // face the way the camera is looking — which is forward, from the player's
    // seat. The head only ever holds the leftover while the body catches up,
    // so it sits neutral almost all the time and turns as a glance, never as a
    // permanent crick toward the camera.
    const target = speed > MOVE_EPSILON
      ? Math.atan2(-this.realised.x, -this.realised.z)
      : lookYaw;
    this.facing = turnToward(this.facing, target, FACING_TURN_RATE * frameDelta);

    const offset = THREE.MathUtils.clamp(
      shortestAngle(this.facing, lookYaw),
      -HEAD_YAW_MAX,
      HEAD_YAW_MAX,
    );
    // Ease the neck so a flick of the mouse glides rather than snapping.
    this.headYaw += (offset - this.headYaw) * (1 - Math.exp(-frameDelta / HEAD_TURN_EASE));
    this.character?.setHeadYaw(this.headYaw);
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

/** Far below the arena floor, where a parked body touches nothing. */
const PARKED: readonly [number, number, number] = [0, -400, 0];
/** Seconds a knocked-out body stays on the ground before disappearing. */
const DEATH_LINGER = 1.6;
/** Seconds the throw one-shot owns the rig. */
const THROW_ANIM_TIME = 0.5;
/** Seconds an emote one-shot owns the rig. */
const EMOTE_TIME = 1.4;

function fmt(v: THREE.Vector3): string {
  return `${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}`;
}

/** Shortest signed angle from `from` to `to`, in (-pi, pi]. */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Shortest-arc turn from `current` toward `target`, capped at `maxDelta`. */
function turnToward(current: number, target: number, maxDelta: number): number {
  return current + THREE.MathUtils.clamp(shortestAngle(current, target), -maxDelta, maxDelta);
}
