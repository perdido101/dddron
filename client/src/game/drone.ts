import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  ALTITUDE_MAX,
  ALTITUDE_MIN,
  ALTITUDE_SPRING,
  ALTITUDE_SPRING_DAMPING,
  COLOR_PROP,
  CYLINDER_SEGMENTS,
  DRONE_ACCELERATION,
  DRONE_ANGULAR_DAMPING,
  DRONE_BODY_HEIGHT,
  DRONE_DOCK_HEIGHT,
  DRONE_RETURN_ACCELERATION,
  DRONE_RETURN_ALTITUDE,
  DRONE_RETURN_SPEED_MULT,
  DRONE_FRICTION,
  DRONE_HOVER_COMPENSATION,
  DRONE_LINEAR_DAMPING,
  DRONE_MASS,
  DRONE_MAX_SPEED,
  DRONE_RADIUS,
  DRONE_SPAWN,
  DRONE_THRUST_CUTOFF,
  DRONE_WANDER_ACCELERATION,
  DRONE_WANDER_HZ_X,
  DRONE_WANDER_HZ_Z,
  DRONE_VERTICAL_ACCELERATION,
  DRONE_YAW_SENSITIVITY,
  BATTERY_COLOR_CRITICAL,
  BATTERY_COLOR_FULL,
  BATTERY_COLOR_LOW,
  BATTERY_GAUGE_HEIGHT,
  BATTERY_GAUGE_WIDTH,
  BATTERY_HALO_OPACITY,
  BATTERY_HALO_OPACITY_LOW,
  BATTERY_HALO_PULSE_HZ,
  BATTERY_HALO_RADIUS,
  BATTERY_HALO_WIDTH,
  BATTERY_LOW_FRACTION,
  GRAVITY,
  PROP_WASH_DOWNFORCE,
  PROP_WASH_FORCE,
  PROP_WASH_RADIUS,
  ROTOR_ARM,
  ROTOR_COUNT,
  ROTOR_RADIUS,
  ROTOR_SPIN_IDLE,
  ROTOR_SPIN_MAX,
  ROTOR_THICKNESS,
  TELEGRAPH_COLOR,
  TELEGRAPH_PULSE_HZ_END,
  TELEGRAPH_PULSE_HZ_START,
  TILT_FULL_SPEED,
  TILT_MAX,
  TILT_RESPONSE,
  WALL_BOUNCE,
} from '@shared/constants';

import { addRimLight } from '../engine/assets';
import { InterpolatedTransform } from '../engine/interpolation';
import type { Physics } from '../engine/physics';
import type { Fuse } from '@shared/fuse';

/** What the pilot is asking for this step. */
export interface DroneInput {
  /** x = strafe, y = forward, each in [-1, 1]. Relative to the drone's facing. */
  readonly move: THREE.Vector2;
  /** +1 climb (Space), -1 descend (Shift). Authored by a human or the script. */
  lift: number;
}

/**
 * The drone.
 *
 * SACRED CONSTRAINT 1: thrust is only ever applied as a force, and velocity is
 * never assigned. Everything that shapes the handling — the damping, the
 * speed-dependent thrust falloff, the altitude spring — is a force acting on a
 * dynamic body, so the drone always carries momentum and can never be parked.
 *
 * The rigid body's own rotation is locked and the tilt you see is cosmetic,
 * driven by velocity. That is deliberate: a freely-tumbling quadcopter makes
 * wall bounces unpredictable and stops reading as comic.
 */
export class Drone {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  /** Facing, driven by the mouse rather than by the direction of travel. */
  yaw = 0;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly transform: InterpolatedTransform;
  private readonly chassis = new THREE.Group();
  private readonly rotors: THREE.Mesh[] = [];
  private readonly material = (() => {
    const material = new THREE.MeshLambertMaterial({ color: COLOR_PROP });
    // The drone must never blend into rooftops or sky (handoff 03): cool
    // grey-white body plus a fresnel rim that draws its edge at range.
    addRimLight(material);
    return material;
  })();
  private gaugeFill!: THREE.Mesh;
  private readonly gaugeMaterial = new THREE.MeshBasicMaterial({ color: BATTERY_COLOR_FULL });
  private halo!: THREE.Mesh;
  private readonly haloMaterial = new THREE.MeshBasicMaterial({
    color: BATTERY_COLOR_FULL,
    transparent: true,
    opacity: BATTERY_HALO_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  /** Charge the halo geometry was last built for, so it rebuilds only on change. */
  private haloCharge = -1;
  private haloClock = 0;
  private telegraphClock = 0;

  private tiltPitch = 0;
  private tiltRoll = 0;
  private previousYaw = 0;
  private yawRateValue = 0;
  private dead = false;
  /** Set by streamer nets (phase 7): 1 is normal, 0.4 is tangled. */
  speedMultiplier = 1;
  /** Grounded by a swat, a thrown prop or a fan. Never lethal. */
  private knockdownTimer = 0;
  private readonly external = new THREE.Vector3();
  private rotorPhase = 0;
  private throttle = 0;
  private active = true;
  private wanderClock = 0;

  private readonly force = new THREE.Vector3();
  private readonly wash = new THREE.Vector3();

  constructor(physics: Physics, scene: THREE.Scene) {
    const [x, y, z] = DRONE_SPAWN;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinearDamping(DRONE_LINEAR_DAMPING)
        .setAngularDamping(DRONE_ANGULAR_DAMPING)
        // Cosmetic tilt only — see the class comment.
        .lockRotations(),
    );

    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cylinder(DRONE_BODY_HEIGHT / 2, DRONE_RADIUS)
        .setRestitution(WALL_BOUNCE)
        // Rapier AVERAGES restitution between the two colliders by default, and
        // the arena's are 0 — which silently halves WALL_BOUNCE and kills the
        // bonk. Max means the drone's own restitution is what you feel.
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(DRONE_FRICTION)
        .setMass(DRONE_MASS),
      this.body,
    );

    this.position.set(x, y, z);
    this.transform = new InterpolatedTransform(this.position);
    this.buildVisual();
    scene.add(this.object);
  }

  private buildVisual(): void {
    const material = this.material;

    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(DRONE_RADIUS, DRONE_RADIUS * 0.82, DRONE_BODY_HEIGHT, CYLINDER_SEGMENTS),
      material,
    );
    hull.castShadow = true;
    this.chassis.add(hull);

    // A nose block so facing is legible before the phase 10 googly eye lands.
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(DRONE_RADIUS * 0.5, DRONE_BODY_HEIGHT * 0.8, DRONE_RADIUS * 0.6),
      material,
    );
    nose.position.z = -DRONE_RADIUS * 0.85;
    nose.castShadow = true;
    this.chassis.add(nose);

    for (let i = 0; i < ROTOR_COUNT; i += 1) {
      const angle = (i / ROTOR_COUNT) * Math.PI * 2 + Math.PI / 4;
      const arm = new THREE.Vector3(Math.cos(angle) * ROTOR_ARM, 0, Math.sin(angle) * ROTOR_ARM);

      const rotor = new THREE.Mesh(
        new THREE.BoxGeometry(ROTOR_RADIUS * 2, ROTOR_THICKNESS, ROTOR_RADIUS * 0.24),
        material,
      );
      rotor.position.copy(arm).setY(DRONE_BODY_HEIGHT * 0.7);
      rotor.castShadow = true;
      this.rotors.push(rotor);
      this.chassis.add(rotor);

      const guard = new THREE.Mesh(
        new THREE.TorusGeometry(ROTOR_RADIUS, ROTOR_THICKNESS, 6, 20),
        material,
      );
      guard.position.copy(rotor.position);
      guard.rotation.x = Math.PI / 2;
      this.chassis.add(guard);
    }

    // Battery gauge: an emissive strip on the hull that mirrors the HUD, so the
    // drone's state is legible from across the arena with no UI at all.
    const backing = new THREE.Mesh(
      new THREE.PlaneGeometry(BATTERY_GAUGE_WIDTH, BATTERY_GAUGE_HEIGHT),
      new THREE.MeshBasicMaterial({ color: 0x22282f }),
    );
    backing.position.set(0, DRONE_BODY_HEIGHT * 0.1, -DRONE_RADIUS * 0.99);
    this.chassis.add(backing);

    this.gaugeFill = new THREE.Mesh(
      new THREE.PlaneGeometry(BATTERY_GAUGE_WIDTH, BATTERY_GAUGE_HEIGHT * GAUGE_INSET),
      this.gaugeMaterial,
    );
    this.gaugeFill.position.set(0, DRONE_BODY_HEIGHT * 0.1, -DRONE_RADIUS * 1.01);
    this.chassis.add(this.gaugeFill);

    // Battery halo: the same reading with no preferred viewing angle, and big
    // enough to survive 30 m of arena. Rebuilt each frame as a partial ring,
    // so charge is legible as an arc as well as a colour.
    this.halo = new THREE.Mesh(new THREE.RingGeometry(1, 1, 1), this.haloMaterial);
    this.halo.rotation.x = -Math.PI / 2;
    // On the object, not the chassis: the readout must not tilt with the body.
    this.object.add(this.halo);

    this.object.add(this.chassis);
  }

  /** Drive the body gauge from the authoritative battery, never from a guess. */
  private renderGauge(charge: number, frameDelta: number): void {
    this.gaugeFill.scale.x = Math.max(charge, 0.001);
    // Scaling a centred plane shrinks it both ways, so shift it to stay left-aligned.
    this.gaugeFill.position.x = -(BATTERY_GAUGE_WIDTH / 2) * (1 - charge);
    const colour = charge <= 0 ? BATTERY_COLOR_CRITICAL
      : charge <= BATTERY_LOW_FRACTION ? BATTERY_COLOR_LOW
      : BATTERY_COLOR_FULL;
    this.gaugeMaterial.color.setHex(colour);
    this.renderHalo(charge, colour, frameDelta);
  }

  /**
   * The halo's arc is the charge and its colour is the band, so it can be read
   * two ways. It brightens and pulses once the battery is low, which is the
   * visual half of the telegraph at a distance where the hull strip is a
   * couple of pixels.
   */
  private renderHalo(charge: number, colour: number, frameDelta: number): void {
    this.haloClock += frameDelta;
    this.haloMaterial.color.setHex(colour);

    // Rebuilding a ring geometry every frame is wasteful for a value that
    // moves ~1% a second, so only rebuild when the arc visibly changes.
    const quantised = Math.round(Math.max(charge, 0) * HALO_STEPS) / HALO_STEPS;
    if (quantised !== this.haloCharge) {
      this.haloCharge = quantised;
      this.halo.geometry.dispose();
      this.halo.geometry = new THREE.RingGeometry(
        BATTERY_HALO_RADIUS,
        BATTERY_HALO_RADIUS + BATTERY_HALO_WIDTH,
        CYLINDER_SEGMENTS,
        1,
        // Start at the top of the ring and open clockwise as it drains.
        Math.PI / 2,
        Math.max(quantised, 0.001) * Math.PI * 2,
      );
    }

    const low = charge <= BATTERY_LOW_FRACTION;
    const pulse = low
      ? 0.5 + 0.5 * Math.sin(this.haloClock * Math.PI * 2 * BATTERY_HALO_PULSE_HZ)
      : 0;
    this.haloMaterial.opacity = this.dead
      ? 0
      : BATTERY_HALO_OPACITY + (BATTERY_HALO_OPACITY_LOW - BATTERY_HALO_OPACITY) * pulse;
  }

  /** Feed raw pointer-lock deltas. The drone turns; it does not pitch. */
  look(deltaX: number): void {
    this.yaw -= deltaX * DRONE_YAW_SENSITIVITY;
  }

  /** Turn toward a heading. Used by the scripted pilot, never by a human. */
  steerTowards(targetYaw: number, dt: number): void {
    let delta = (targetYaw - this.yaw) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    this.yaw += THREE.MathUtils.clamp(delta, -AI_TURN_RATE * dt, AI_TURN_RATE * dt);
  }

  /**
   * Take an outside force for one step — ceiling fans, mostly. Accumulated and
   * applied with the drone's own forces so it is one solve, not two.
   */
  applyExternalForce(x: number, y: number, z: number): void {
    this.external.x += x;
    this.external.y += y;
    this.external.z += z;
  }

  /**
   * Knocked out of the air. SACRED CONSTRAINT 4: this never kills the drone,
   * it only costs it time and forces a return to a pad.
   */
  knockdown(seconds: number): void {
    this.knockdownTimer = Math.max(this.knockdownTimer, seconds);
  }

  get knocked(): boolean {
    return this.knockdownTimer > 0;
  }

  /** The EMP fired. The drone is permanently dead — this is the runners' win. */
  kill(): void {
    this.dead = true;
    this.material.emissive.setHex(0);
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** The tilting body, which the FPV camera bolts onto. */
  get chassisObject(): THREE.Object3D {
    return this.chassis;
  }

  /**
   * Take the local drone out of the world entirely.
   *
   * Online exactly one client flies the drone and every other client sees it
   * as a relayed avatar. Without this those clients keep simulating their own
   * copy of it, which draws a second drone in the wrong place and shoves
   * runners around with prop wash nobody caused. Disabling the rigid body
   * removes it from the physics world rather than merely hiding it, so the
   * phantom cannot collide with anything either.
   *
   * Simulating and being seen are separate. The host also flies the bot drone
   * when nobody human took the seat: that body must simulate, but the host
   * still draws it through the same relayed avatar everyone else sees, so
   * there is one drone on screen rather than two a few frames apart.
   *
   * @param visible defaults to `active`; pass false to simulate unseen.
   */
  setActive(active: boolean, visible = active): void {
    this.object.visible = visible;
    if (this.active === active) return;
    this.active = active;
    this.body.setEnabled(active);
    if (active) this.relaunch();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Fraction of a full turn the battery halo currently spans. Test hook. */
  get haloArcTurns(): number {
    return this.haloCharge;
  }

  /**
   * Hide the drone's own hull and rotors. The onboard camera sits between the
   * rotors, so from inside the feed they fill the frame and read as clutter --
   * you are looking OUT of the drone, not at it.
   */
  setBodyVisible(visible: boolean): void {
    this.chassis.visible = visible;
  }

  /** Radians per second of turn, which is what skews a cheap rolling shutter. */
  get yawRate(): number {
    return this.yawRateValue;
  }

  get pitchAngle(): number {
    return this.tiltPitch;
  }

  get rollAngle(): number {
    return this.tiltRoll;
  }

  /**
   * One fixed step of piloting. Call before the world steps.
   *
   * Prop wash is deliberately NOT applied here — see applyPropWash, which the
   * game loop calls separately so a client with no drone body still feels it.
   */
  fixedUpdate(dt: number, input: DroneInput, fuse: Fuse): void {
    // Stowed: somebody else is flying, and this copy is not in the world.
    if (!this.active) return;

    // Rapier's addForce is PERSISTENT: it keeps applying every step until the
    // accumulator is cleared. Without this reset the hover force compounds each
    // tick and the drone leaves the arena at absurd speed.
    this.body.resetForces(false);

    const linvel = this.body.linvel();
    this.velocity.set(linvel.x, linvel.y, linvel.z);
    this.force.set(0, 0, 0);

    // External forces (fans) always apply, even mid-knockdown — being flung
    // while already tumbling is the funniest thing that can happen to it.
    this.force.add(this.external);
    this.external.set(0, 0, 0);

    if (this.dead) {
      // Dead weight. Gravity is the only thing acting on it now.
      this.throttle = 0;
      this.body.addForce(this.force, true);
      return;
    }

    if (this.knockdownTimer > 0) {
      this.knockdownTimer -= dt;
      // No lift, no thrust, no wash: it is on the floor until it recovers.
      this.throttle = 0;
      this.body.addForce(this.force, true);
      return;
    }

    if (fuse.piloted) {
      this.applyHorizontalThrust(input);
      this.applyVerticalThrust(input);
      this.applyAltitudeSpring();
      this.applyWander(dt);
      this.throttle = Math.min(Math.hypot(input.move.x, input.move.y) + Math.abs(input.lift), 1);
      this.body.addForce(this.force, true);
      return;
    }

    if (fuse.state === 'returning') {
      this.applyReturnAutopilot(fuse);
      this.throttle = DRONE_RETURN_SPEED_MULT;
      this.body.addForce(this.force, true);
      // NO prop wash while limping home. The drone always returns to a pad a
      // runner has just cleared, so a live wash on the return leg means it
      // lands on top of whoever took the core, knocks it out of their hands,
      // and the core drops straight back onto the pad -- blocking the very pad
      // the drone was flying to. That deadlocks both sides. On emergency power
      // it is a vulnerable object, not a weapon.
      return;
    }

    // Inert or docked: no rotors, no lift, no wash. It is dead weight that
    // falls, and a sitting target once it is on the pad.
    this.throttle = 0;
  }

  /**
   * Flies itself back to a charge pad at reduced speed after a detonation.
   * Proportional steering, no pathfinding — it will bonk off things on the way,
   * which is the point.
   */
  private applyReturnAutopilot(fuse: Fuse): void {
    const pad = fuse.pad;
    if (!pad) return;
    const position = this.body.translation();
    const [padX, padZ] = pad;

    const dx = padX - position.x;
    const dz = padZ - position.z;
    const distance = Math.hypot(dx, dz);

    // Hold a safe altitude until roughly overhead, then settle onto the pad.
    const targetY = distance > DRONE_DOCK_HEIGHT * 2 ? DRONE_RETURN_ALTITUDE : DRONE_DOCK_HEIGHT;
    const accel = DRONE_RETURN_ACCELERATION * DRONE_RETURN_SPEED_MULT;

    if (distance > 1e-3) {
      this.force.x += (dx / distance) * accel * DRONE_MASS;
      this.force.z += (dz / distance) * accel * DRONE_MASS;
    }
    this.force.y +=
      (-GRAVITY + (targetY - position.y) * ALTITUDE_SPRING - this.velocity.y * ALTITUDE_SPRING_DAMPING) *
      DRONE_MASS *
      DRONE_HOVER_COMPENSATION;
  }

  /** True once the falling drone has settled, so the inert timer can start. */
  get settled(): boolean {
    return Math.abs(this.velocity.y) < SETTLED_SPEED;
  }

  /**
   * Thrust falls off as the drone approaches DRONE_MAX_SPEED, which caps top
   * speed without ever touching the velocity directly. Damping still applies,
   * so releasing the stick produces a long drift rather than a stop.
   */
  private applyHorizontalThrust(input: DroneInput): void {
    const magnitude = Math.hypot(input.move.x, input.move.y);
    if (magnitude <= 0) return;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dirX = -sin * input.move.y + cos * input.move.x;
    const dirZ = -cos * input.move.y - sin * input.move.x;
    const scale = magnitude > 1 ? 1 / magnitude : 1;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const cutoff = DRONE_THRUST_CUTOFF * this.speedMultiplier;
    const thrust = speed >= cutoff ? 0 : DRONE_ACCELERATION * DRONE_MASS * this.speedMultiplier;

    this.force.x += dirX * scale * thrust;
    this.force.z += dirZ * scale * thrust;
  }

  /** Rotors carry the drone's weight; Space and Shift are climb authority. */
  private applyVerticalThrust(input: DroneInput): void {
    this.force.y += -GRAVITY * DRONE_MASS * DRONE_HOVER_COMPENSATION;
    if (input.lift !== 0 && Math.abs(this.velocity.y) < DRONE_THRUST_CUTOFF) {
      this.force.y += input.lift * DRONE_VERTICAL_ACCELERATION * DRONE_MASS;
    }
  }

  /**
   * Soft spring outside the altitude band, not a hard clamp. The drone can
   * overshoot the boundary and gets pushed back, which keeps the ceiling and
   * floor feeling springy rather than like invisible walls.
   */
  private applyAltitudeSpring(): void {
    const y = this.body.translation().y;
    let overshoot = 0;
    if (y < ALTITUDE_MIN) overshoot = ALTITUDE_MIN - y;
    else if (y > ALTITUDE_MAX) overshoot = ALTITUDE_MAX - y;
    if (overshoot === 0) return;

    this.force.y +=
      (overshoot * ALTITUDE_SPRING - this.velocity.y * ALTITUDE_SPRING_DAMPING) * DRONE_MASS;
  }

  /**
   * The drone is never perfectly still. Sacred constraint 1 is about more than
   * momentum: a drone that can be parked on a target kills the game, so it
   * always creeps. Deterministic, so two clients agree.
   */
  private applyWander(dt: number): void {
    if (DRONE_WANDER_ACCELERATION === 0) return;
    this.wanderClock += dt;
    const t = this.wanderClock * Math.PI * 2;
    const scale = DRONE_WANDER_ACCELERATION * DRONE_MASS;
    this.force.x += Math.sin(t * DRONE_WANDER_HZ_X) * scale;
    this.force.z += Math.cos(t * DRONE_WANDER_HZ_Z) * scale;
  }

  /**
   * Continuous radial shove on anything under the rotors, falling off with
   * distance. Pushes only — this never damages (brief, phase 2).
   *
   * Applied from `position` rather than from the rigid body, and called by the
   * game loop rather than from fixedUpdate. That matters online: a runner's
   * client has no drone body of its own, only the relayed position, and
   * shoving *our own* runner from it is exactly right under sacred constraint
   * 5 — our body is ours to move. Driving it off the body instead meant prop
   * wash did nothing at all to anyone but the pilot.
   */
  applyPropWash(dt: number, targets: readonly PropWashTarget[]): void {
    const origin = this.position;
    for (const target of targets) {
      const dx = target.position.x - origin.x;
      const dy = target.position.y - origin.y;
      const dz = target.position.z - origin.z;
      // 3-D distance, not horizontal: a drone up at the ceiling must NOT be
      // able to shove someone on the floor. It has to commit to coming down.
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > PROP_WASH_RADIUS) continue;

      const falloff = 1 - distance / PROP_WASH_RADIUS;
      // The shove itself is horizontal — it blows runners outward from under
      // the rotors. Directly underneath there is no radial direction, so nudge
      // along the drone's facing rather than dividing by zero.
      const flat = Math.hypot(dx, dz);
      const nx = flat > 1e-3 ? dx / flat : Math.sin(this.yaw);
      const nz = flat > 1e-3 ? dz / flat : Math.cos(this.yaw);

      this.wash.set(
        nx * PROP_WASH_FORCE * falloff,
        -PROP_WASH_FORCE * falloff * PROP_WASH_DOWNFORCE,
        nz * PROP_WASH_FORCE * falloff,
      );
      target.applyPush(this.wash, dt);
    }
  }

  /** Call after the world steps. */
  sample(): void {
    if (!this.active) return;
    const t = this.body.translation();
    this.position.set(t.x, t.y, t.z);
    this.transform.push(this.position);
  }

  render(alpha: number, frameDelta: number, telegraph = 0, charge = 1): void {
    if (!this.active) return;
    this.renderGauge(charge, frameDelta);
    this.transform.readPosition(this.object.position, alpha);
    this.renderTelegraph(frameDelta, this.dead ? 0 : telegraph);

    if (frameDelta > 0) {
      let delta = (this.yaw - this.previousYaw) % (Math.PI * 2);
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.yawRateValue = delta / frameDelta;
      this.previousYaw = this.yaw;
    }

    // Tilt follows velocity, capped at TILT_MAX, and is eased so a bounce does
    // not snap the body around.
    const localForward = -(this.velocity.z * Math.cos(this.yaw) + this.velocity.x * Math.sin(this.yaw));
    const localRight = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    const targetPitch = THREE.MathUtils.clamp(localForward / TILT_FULL_SPEED, -1, 1) * TILT_MAX;
    const targetRoll = THREE.MathUtils.clamp(-localRight / TILT_FULL_SPEED, -1, 1) * TILT_MAX;

    const blend = 1 - Math.exp(-TILT_RESPONSE * frameDelta);
    this.tiltPitch += (targetPitch - this.tiltPitch) * blend;
    this.tiltRoll += (targetRoll - this.tiltRoll) * blend;

    this.object.rotation.set(0, this.yaw, 0);
    this.chassis.rotation.set(this.tiltPitch, 0, this.tiltRoll);

    const spin = ROTOR_SPIN_IDLE + (ROTOR_SPIN_MAX - ROTOR_SPIN_IDLE) * this.throttle;
    this.rotorPhase += spin * frameDelta;
    for (let i = 0; i < this.rotors.length; i += 1) {
      const rotor = this.rotors[i];
      if (!rotor) continue;
      // Alternate direction, as a real quadcopter does.
      rotor.rotation.y = i % 2 === 0 ? this.rotorPhase : -this.rotorPhase;
    }
  }

  /**
   * Red pulse over the final seconds of the fuse, accelerating as it runs out.
   * Paired with the rising prop pitch, this is the whole telegraph — it has to
   * be unmistakable, because the runners' only defence is knowing to get clear.
   */
  private renderTelegraph(frameDelta: number, telegraph: number): void {
    if (telegraph <= 0) {
      this.telegraphClock = 0;
      this.material.emissive.setHex(0);
      return;
    }
    const hz = TELEGRAPH_PULSE_HZ_START + (TELEGRAPH_PULSE_HZ_END - TELEGRAPH_PULSE_HZ_START) * telegraph;
    this.telegraphClock += frameDelta * hz;
    const flash = 0.5 + 0.5 * Math.sin(this.telegraphClock * Math.PI * 2);
    this.material.emissive.setHex(TELEGRAPH_COLOR);
    this.material.emissiveIntensity = flash;
  }

  /**
   * Deterministic reset: identical position, velocity, yaw and wander phase,
   * so two runs of the same scripted input sequence are comparable. Add-on 01
   * requires flight parity to be verified by measurement, and measurement is
   * meaningless without identical initial conditions.
   */
  resetForTest(): void {
    const [x, y, z] = DRONE_SPAWN;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.yaw = 0;
    this.previousYaw = 0;
    this.tiltPitch = 0;
    this.tiltRoll = 0;
    this.wanderClock = 0;
    // The halo's pulse and its cached arc are part of the visible state, so a
    // "deterministic reset" that leaves them running is not one.
    this.haloClock = 0;
    this.haloCharge = -1;
    this.position.set(x, y, z);
    this.transform.teleport(this.position);
  }

  /** Put the drone back at its launch point on a fresh cycle. */
  relaunch(): void {
    this.placeAt(DRONE_SPAWN[0], DRONE_SPAWN[1], DRONE_SPAWN[2]);
  }

  /**
   * Drop the drone at an exact point with no velocity.
   *
   * Used by measurement scripts: flying it somewhere open-loop is unreliable
   * at low frame rates, and a test that cannot reach its own setup reliably
   * proves nothing about what it was trying to measure.
   */
  placeAt(x: number, y: number, z: number): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.position.set(x, y, z);
    this.transform.teleport(this.position);
  }

  /** The drone's own collider, so the chase camera does not collide with it. */
  get hullCollider(): RAPIER.Collider {
    return this.collider;
  }

  /** 0-1, how hard the rotors are working. Drives the whine's pitch. */
  get throttleLevel(): number {
    return this.throttle;
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  debugLines(): string[] {
    return [
      `drone pos    ${this.position.x.toFixed(2)}, ${this.position.y.toFixed(2)}, ${this.position.z.toFixed(2)}`,
      `drone speed  ${this.speed.toFixed(2)} m/s  (max ${DRONE_MAX_SPEED})  vy ${this.velocity.y.toFixed(2)}`,
      `drone tilt   ${THREE.MathUtils.radToDeg(Math.hypot(this.tiltPitch, this.tiltRoll)).toFixed(1)}deg` +
        ` (max ${THREE.MathUtils.radToDeg(TILT_MAX).toFixed(0)})`,
    ];
  }
}

/** How fast the scripted pilot may swing the drone around, in rad/s. */
const AI_TURN_RATE = 2.2;
/** The fill sits slightly inside its backing so the gauge has a visible border. */
const GAUGE_INSET = 0.72;
/**
 * Charge is quantised to this many steps before the halo's arc is rebuilt.
 * Fifty is finer than the eye resolves on a ring at range, and it turns a
 * per-frame geometry rebuild into roughly one a second.
 */
const HALO_STEPS = 50;

/** Vertical speed below which a falling drone counts as landed. */
const SETTLED_SPEED = 0.5;

/** Anything prop wash can shove. */
export interface PropWashTarget {
  readonly position: THREE.Vector3;
  applyPush(force: THREE.Vector3, dt: number): void;
}
