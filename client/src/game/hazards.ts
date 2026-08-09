import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  ARENA_CEILING,
  CHARGE_PAD_POSITIONS,
  COLOR_CORE,
  COLOR_PROP,
  FAN_FORCE,
  FAN_POSITIONS,
  FAN_RADIUS,
  NET_POSITIONS,
  NET_SLOW_FACTOR,
  NET_SLOW_TIME,
  SABOTAGE_DISABLE_TIME,
  SABOTAGE_HOLD,
  SWAT_ARC,
  SWAT_COOLDOWN,
  SWAT_RANGE,
  THROWABLE_COUNT,
  THROWABLE_RADIUS,
  THROW_FORCE,
  THROW_SPREAD,
} from '@shared/constants';

import { InterpolatedTransform } from '../engine/interpolation';
import type { Physics } from '../engine/physics';

import type { Drone } from './drone';
import type { Runner } from './runner';

/** A loose prop that can be picked up and thrown at the drone. */
interface Throwable {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  transform: InterpolatedTransform;
  held: boolean;
}

export interface HazardStatus {
  readonly swatCooldown: number;
  readonly holdingProp: boolean;
  readonly netSlow: number;
  readonly sabotage: { readonly progress: number; readonly pad: number } | null;
  readonly padsDisabled: readonly number[];
  readonly prompt: string | null;
}

/**
 * Runners' physical answers to the drone.
 *
 * SACRED CONSTRAINT 4 runs through all of this: nothing here can kill the
 * drone. Every hazard produces the same currency — a knockdown, which costs the
 * drone TIME and forces it back to a pad. The reward for counterplay is never
 * victory, only breathing room.
 */
export class Hazards {
  /** Set on any knockdown so the round can tell the server. */
  knockdownRequested = false;

  private readonly throwables: Throwable[] = [];
  private readonly fans: THREE.Mesh[] = [];
  private readonly nets: { mesh: THREE.Mesh; x: number; z: number; width: number; yaw: number }[] = [];

  private swatTimer = 0;
  private netSlowTimer = 0;
  private heldProp: Throwable | null = null;
  private sabotagePad = -1;
  private sabotageTimer = 0;
  private readonly disabledPads = new Map<number, number>();
  private prompt: string | null = null;
  private enabled = true;
  private sabotageCompleted = 0;

  private readonly swatArc: THREE.Mesh;
  private swatFlash = 0;
  private swingYaw = 0;

  constructor(private readonly physics: Physics, private readonly scene: THREE.Scene) {
    this.buildFans();
    this.buildNets();
    this.buildThrowables();

    // A visible arc so the swing reads; replaced by an animation in phase 10.
    this.swatArc = new THREE.Mesh(
      new THREE.RingGeometry(SWAT_RANGE * 0.45, SWAT_RANGE, 20, 1, -SWAT_ARC / 2, SWAT_ARC),
      new THREE.MeshBasicMaterial({ color: COLOR_CORE, transparent: true, opacity: 0, side: THREE.DoubleSide }),
    );
    this.swatArc.rotation.x = -Math.PI / 2;
    this.scene.add(this.swatArc);
  }

  private buildFans(): void {
    const material = new THREE.MeshLambertMaterial({ color: COLOR_PROP });
    for (const [x, z] of FAN_POSITIONS) {
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(FAN_RADIUS * 2, FAN_BLADE_THICKNESS, FAN_RADIUS * 0.34),
        material,
      );
      blade.position.set(x, ARENA_CEILING - FAN_DROP, z);
      blade.castShadow = true;
      this.scene.add(blade);
      this.fans.push(blade);
    }
  }

  private buildNets(): void {
    const material = new THREE.MeshLambertMaterial({
      color: COLOR_PROP,
      transparent: true,
      opacity: NET_OPACITY,
      side: THREE.DoubleSide,
    });
    for (const [x, z, width, yaw] of NET_POSITIONS) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, NET_HEIGHT), material);
      mesh.position.set(x, NET_HEIGHT / 2 + NET_GROUND_GAP, z);
      mesh.rotation.y = yaw;
      this.scene.add(mesh);
      this.nets.push({ mesh, x, z, width, yaw });
    }
  }

  private buildThrowables(): void {
    const material = new THREE.MeshLambertMaterial({ color: COLOR_CORE });
    for (let i = 0; i < THROWABLE_COUNT; i += 1) {
      // Spread them around the ring between the pads, where fights happen.
      const angle = (i / THROWABLE_COUNT) * Math.PI * 2;
      const x = Math.cos(angle) * THROWABLE_RING;
      const z = Math.sin(angle) * THROWABLE_RING;

      const body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, THROWABLE_RADIUS, z).setLinearDamping(THROWABLE_DAMPING),
      );
      this.physics.world.createCollider(RAPIER.ColliderDesc.ball(THROWABLE_RADIUS), body);

      const mesh = new THREE.Mesh(new THREE.SphereGeometry(THROWABLE_RADIUS, 12, 10), material);
      mesh.castShadow = true;
      this.scene.add(mesh);

      this.throwables.push({
        body,
        mesh,
        transform: new InterpolatedTransform(body.translation(), body.rotation()),
        held: false,
      });
    }
  }

  /**
   * Turn every hazard off at once.
   *
   * A playtest question the brief cares about is whether the drone is only
   * survivable *because* of the hazards. Switching them off mid-round answers
   * it directly instead of by argument.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.netSlowTimer = 0;
      this.disabledPads.clear();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** One fixed step. Call before the world steps. */
  fixedUpdate(dt: number, runner: Runner, drone: Drone, interact: boolean): void {
    if (!this.enabled) {
      // Leave the drone unencumbered rather than frozen at the last multiplier.
      drone.speedMultiplier = 1;
      return;
    }
    this.swatTimer = Math.max(0, this.swatTimer - dt);
    this.netSlowTimer = Math.max(0, this.netSlowTimer - dt);
    for (const [pad, remaining] of this.disabledPads) {
      const left = remaining - dt;
      if (left <= 0) this.disabledPads.delete(pad);
      else this.disabledPads.set(pad, left);
    }

    this.applyFans(drone);
    this.applyNets(drone);
    this.carryProp(runner);
    this.updateSabotage(dt, runner, interact);
  }

  /**
   * Ceiling fans, always on. The drone entering the wash is flung violently;
   * runners are unaffected, so the fan is a hazard only for the thing that
   * flies.
   */
  private applyFans(drone: Drone): void {
    for (const blade of this.fans) {
      const dx = drone.position.x - blade.position.x;
      const dz = drone.position.z - blade.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance > FAN_RADIUS || drone.position.y < ARENA_CEILING - FAN_REACH) continue;

      const falloff = 1 - distance / FAN_RADIUS;
      const outward = distance > 1e-3 ? 1 / distance : 0;
      drone.applyExternalForce(
        dx * outward * FAN_FORCE * falloff,
        -FAN_FORCE * falloff * FAN_DOWNWASH,
        dz * outward * FAN_FORCE * falloff,
      );
    }
  }

  /** Streamer nets: passing through slows the drone and tangles its props. */
  private applyNets(drone: Drone): void {
    for (const net of this.nets) {
      const dx = drone.position.x - net.x;
      const dz = drone.position.z - net.z;
      // Distance from the net's plane, along its normal.
      const normalX = Math.cos(net.yaw);
      const normalZ = -Math.sin(net.yaw);
      const throughPlane = Math.abs(dx * normalX + dz * normalZ);
      const alongPlane = Math.abs(-dx * normalZ + dz * normalX);
      if (throughPlane > NET_THICKNESS || alongPlane > net.width / 2) continue;
      if (drone.position.y > NET_HEIGHT + NET_GROUND_GAP) continue;
      this.netSlowTimer = NET_SLOW_TIME;
    }
    drone.speedMultiplier = this.netSlowTimer > 0 ? NET_SLOW_FACTOR : 1;
  }

  /** Melee arc on F. Hitting the drone knocks it down; it never kills it. */
  swat(runner: Runner, drone: Drone, yaw: number): boolean {
    if (!this.enabled) return false;
    if (this.swatTimer > 0) return false;
    this.swingYaw = yaw;
    this.swatTimer = SWAT_COOLDOWN;
    this.swatFlash = SWAT_FLASH_TIME;

    const dx = drone.position.x - runner.position.x;
    const dy = drone.position.y - runner.position.y;
    const dz = drone.position.z - runner.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > SWAT_RANGE) return false;

    // Inside the arc in front of the runner, not a 360-degree sweep.
    const toDrone = Math.atan2(-dx, -dz);
    let offset = (toDrone - this.swingYaw) % (Math.PI * 2);
    if (offset > Math.PI) offset -= Math.PI * 2;
    if (offset < -Math.PI) offset += Math.PI * 2;
    if (Math.abs(offset) > SWAT_ARC / 2) return false;

    this.knockdownRequested = true;
    return true;
  }

  /** Pick up or throw a loose prop. Physics-driven and deliberately inaccurate. */
  toggleProp(runner: Runner, yaw: number): void {
    if (this.heldProp) {
      const prop = this.heldProp;
      prop.held = false;
      this.heldProp = null;
      // Spread is applied per throw, so nobody is a marksman with a bucket.
      const spread = (Math.random() - 0.5) * THROW_SPREAD * 2;
      const aim = yaw + spread;
      prop.body.setLinvel(
        {
          x: -Math.sin(aim) * THROW_FORCE,
          y: THROW_FORCE * THROW_LOFT,
          z: -Math.cos(aim) * THROW_FORCE,
        },
        true,
      );
      return;
    }

    let nearest: Throwable | null = null;
    let nearestDistance = PROP_PICKUP_RADIUS;
    for (const prop of this.throwables) {
      const t = prop.body.translation();
      const distance = Math.hypot(t.x - runner.position.x, t.z - runner.position.z);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = prop;
      }
    }
    if (nearest) {
      nearest.held = true;
      this.heldProp = nearest;
    }
  }

  private carryProp(runner: Runner): void {
    const prop = this.heldProp;
    if (!prop) return;
    prop.body.setTranslation(
      { x: runner.position.x, y: runner.position.y + PROP_CARRY_HEIGHT, z: runner.position.z },
      true,
    );
    prop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** A thrown prop that connects knocks the drone down, same as a swat. */
  checkPropHits(drone: Drone): void {
    for (const prop of this.throwables) {
      if (prop.held) continue;
      const velocity = prop.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      if (speed < PROP_HIT_SPEED) continue;

      const t = prop.body.translation();
      const distance = Math.hypot(
        t.x - drone.position.x,
        t.y - drone.position.y,
        t.z - drone.position.z,
      );
      if (distance <= THROWABLE_RADIUS + PROP_HIT_RADIUS) this.knockdownRequested = true;
    }
  }

  /**
   * Sabotage: hold E on an EMPTY charge pad to disable it. Slow and loud, and
   * it pins the runner in exactly the place the drone wants to be.
   */
  private updateSabotage(dt: number, runner: Runner, interact: boolean): void {
    this.prompt = null;
    if (!runner.alive || runner.carrying) {
      this.sabotagePad = -1;
      this.sabotageTimer = 0;
      return;
    }

    let pad = -1;
    for (let i = 0; i < CHARGE_PAD_POSITIONS.length; i += 1) {
      const [x, z] = CHARGE_PAD_POSITIONS[i]!;
      if (Math.hypot(runner.position.x - x, runner.position.z - z) <= SABOTAGE_RADIUS) pad = i;
    }
    if (pad < 0 || this.disabledPads.has(pad)) {
      this.sabotagePad = -1;
      this.sabotageTimer = 0;
      return;
    }

    this.prompt = 'hold E to sabotage this charge pad';
    if (!interact) {
      this.sabotagePad = -1;
      this.sabotageTimer = 0;
      return;
    }
    if (this.sabotagePad !== pad) {
      this.sabotagePad = pad;
      this.sabotageTimer = 0;
    }
    this.sabotageTimer += dt;
    if (this.sabotageTimer >= SABOTAGE_HOLD) {
      this.disabledPads.set(pad, SABOTAGE_DISABLE_TIME);
      this.sabotagePad = -1;
      this.sabotageTimer = 0;
      this.sabotageCompleted += 1;
    }
  }

  /** Sabotages finished since the last read. Read once per step for telemetry. */
  consumeSabotages(): number {
    const count = this.sabotageCompleted;
    this.sabotageCompleted = 0;
    return count;
  }

  /** Pads a runner has sabotaged, which the drone may not dock on. */
  disabledPadIndices(): number[] {
    return [...this.disabledPads.keys()];
  }

  /** Call after the world steps. */
  sample(): void {
    for (const prop of this.throwables) {
      prop.transform.push(prop.body.translation(), prop.body.rotation());
    }
  }

  render(alpha: number, frameDelta: number, runner: Runner): void {
    for (const prop of this.throwables) prop.transform.applyTo(prop.mesh, alpha);

    // Fans spin permanently: they are always on, and a still blade reads as off.
    for (const blade of this.fans) blade.rotation.y += FAN_SPIN * frameDelta;

    this.swatFlash = Math.max(0, this.swatFlash - frameDelta);
    const material = this.swatArc.material as THREE.MeshBasicMaterial;
    material.opacity = (this.swatFlash / SWAT_FLASH_TIME) * SWAT_ARC_OPACITY;
    this.swatArc.visible = this.swatFlash > 0;
    this.swatArc.position.copy(runner.object.position);
    this.swatArc.rotation.z = -this.swingYaw;
  }

  status(): HazardStatus {
    return {
      swatCooldown: this.swatTimer,
      holdingProp: this.heldProp !== null,
      netSlow: this.netSlowTimer,
      sabotage: this.sabotagePad >= 0
        ? { progress: this.sabotageTimer / SABOTAGE_HOLD, pad: this.sabotagePad }
        : null,
      padsDisabled: this.disabledPadIndices(),
      prompt: this.prompt,
    };
  }
}

/** unspecified presentation and tuning for the hazards. */
const FAN_BLADE_THICKNESS = 0.18;
const FAN_DROP = 0.6;
/** How far below a fan its wash still reaches. */
const FAN_REACH = 5.0;
const FAN_DOWNWASH = 0.5;
const FAN_SPIN = 6.0;
const NET_HEIGHT = 3.4;
const NET_GROUND_GAP = 0.6;
const NET_THICKNESS = 0.6;
const NET_OPACITY = 0.45;
const THROWABLE_RING = 11.0;
const THROWABLE_DAMPING = 0.4;
const PROP_PICKUP_RADIUS = 1.6;
const PROP_CARRY_HEIGHT = 1.3;
const PROP_HIT_SPEED = 4.0;
const PROP_HIT_RADIUS = 0.7;
const THROW_LOFT = 0.35;
const SABOTAGE_RADIUS = 2.2;
const SWAT_FLASH_TIME = 0.18;
const SWAT_ARC_OPACITY = 0.55;
