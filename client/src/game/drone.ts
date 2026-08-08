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
  TILT_FULL_SPEED,
  TILT_MAX,
  TILT_RESPONSE,
  WALL_BOUNCE,
} from '@shared/constants';

import { InterpolatedTransform } from '../engine/interpolation';
import type { Physics } from '../engine/physics';

/** What the pilot is asking for this step. */
export interface DroneInput {
  /** x = strafe, y = forward, each in [-1, 1]. Relative to the drone's facing. */
  readonly move: THREE.Vector2;
  /** +1 climb (Space), -1 descend (Shift). */
  readonly lift: number;
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

  private tiltPitch = 0;
  private tiltRoll = 0;
  private rotorPhase = 0;
  private throttle = 0;
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
    const material = new THREE.MeshLambertMaterial({ color: COLOR_PROP });

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

    this.object.add(this.chassis);
  }

  /** Feed raw pointer-lock deltas. The drone turns; it does not pitch. */
  look(deltaX: number): void {
    this.yaw -= deltaX * DRONE_YAW_SENSITIVITY;
  }

  /**
   * One fixed step of piloting. Call before the world steps.
   *
   * @param runners bodies to shove with prop wash.
   */
  fixedUpdate(dt: number, input: DroneInput, runners: readonly PropWashTarget[]): void {
    // Rapier's addForce is PERSISTENT: it keeps applying every step until the
    // accumulator is cleared. Without this reset the hover force compounds each
    // tick and the drone leaves the arena at absurd speed.
    this.body.resetForces(false);

    const linvel = this.body.linvel();
    this.velocity.set(linvel.x, linvel.y, linvel.z);
    this.force.set(0, 0, 0);

    this.applyHorizontalThrust(input);
    this.applyVerticalThrust(input);
    this.applyAltitudeSpring();
    this.applyWander(dt);

    this.body.addForce(this.force, true);
    this.applyPropWash(dt, runners);

    this.throttle = Math.min(
      Math.hypot(input.move.x, input.move.y) + Math.abs(input.lift),
      1,
    );
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
    const thrust = speed >= DRONE_THRUST_CUTOFF ? 0 : DRONE_ACCELERATION * DRONE_MASS;

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
    this.wanderClock += dt;
    const t = this.wanderClock * Math.PI * 2;
    const scale = DRONE_WANDER_ACCELERATION * DRONE_MASS;
    this.force.x += Math.sin(t * DRONE_WANDER_HZ_X) * scale;
    this.force.z += Math.cos(t * DRONE_WANDER_HZ_Z) * scale;
  }

  /**
   * Continuous radial shove on anything under the rotors, falling off with
   * distance. Pushes only — this never damages (brief, phase 2).
   */
  private applyPropWash(dt: number, targets: readonly PropWashTarget[]): void {
    const origin = this.body.translation();
    for (const target of targets) {
      const dx = target.position.x - origin.x;
      const dz = target.position.z - origin.z;
      const distance = Math.hypot(dx, dz);
      if (distance > PROP_WASH_RADIUS) continue;

      const falloff = 1 - distance / PROP_WASH_RADIUS;
      // Directly underneath, there is no radial direction to push along; nudge
      // outward along the drone's facing instead of dividing by zero.
      const nx = distance > 1e-3 ? dx / distance : Math.sin(this.yaw);
      const nz = distance > 1e-3 ? dz / distance : Math.cos(this.yaw);

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
    const t = this.body.translation();
    this.position.set(t.x, t.y, t.z);
    this.transform.push(this.position);
  }

  render(alpha: number, frameDelta: number): void {
    this.transform.readPosition(this.object.position, alpha);

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

  /** The drone's own collider, so the chase camera does not collide with it. */
  get hullCollider(): RAPIER.Collider {
    return this.collider;
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

/** Anything prop wash can shove. */
export interface PropWashTarget {
  readonly position: THREE.Vector3;
  applyPush(force: THREE.Vector3, dt: number): void;
}
