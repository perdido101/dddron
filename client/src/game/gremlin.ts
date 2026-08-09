import * as THREE from 'three';

import {
  ARENA_HALF,
  ARENA_CEILING,
  COLOR_EMP_STATION,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  GREMLIN_ACTIONS_PER_CYCLE,
  GREMLIN_EXCLUSION_RADIUS,
  GREMLIN_RADIUS,
  GREMLIN_SMOKE_RADIUS,
  GREMLIN_SMOKE_TIME,
  GREMLIN_SPEED,
} from '@shared/constants';

/** What a gremlin can do with its one trigger per detonation cycle. */
export type GremlinAction = 'throwable' | 'smoke';

export interface GremlinStatus {
  readonly active: boolean;
  readonly actionsLeft: number;
  readonly blocked: string | null;
}

/**
 * Eliminated runners.
 *
 * Being blown up should not mean sitting on your hands for two minutes, so the
 * dead fly around as visible gremlins and get exactly one hazard trigger per
 * detonation cycle. The cooldown is the whole balance: it resets on detonation
 * and nowhere else, so spamming is structurally impossible rather than
 * rate-limited.
 *
 * Gremlin actions are deliberately usable to help EITHER side. That is a
 * feature, not an oversight, and nothing here restricts targeting — except that
 * a gremlin may not park on the EMP station or body-block the drone, which the
 * exclusion check below enforces.
 */
export class Gremlin {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  active = false;

  private actionsLeft = GREMLIN_ACTIONS_PER_CYCLE;
  private blocked: string | null = null;
  private readonly velocity = new THREE.Vector3();
  private readonly smoke: THREE.Mesh;
  private smokeTimer = 0;
  private bobClock = 0;

  constructor(scene: THREE.Scene) {
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(GREMLIN_RADIUS, 14, 12),
      new THREE.MeshLambertMaterial({
        color: COLOR_EMP_STATION,
        transparent: true,
        opacity: GREMLIN_OPACITY,
      }),
    );
    this.object.add(body);
    this.object.visible = false;
    scene.add(this.object);

    this.smoke = new THREE.Mesh(
      new THREE.SphereGeometry(GREMLIN_SMOKE_RADIUS, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0 }),
    );
    this.smoke.visible = false;
    scene.add(this.smoke);
  }

  /** Called when the runner is eliminated. */
  enter(at: THREE.Vector3): void {
    this.active = true;
    this.position.copy(at).setY(Math.max(at.y, GREMLIN_FLOOR));
    this.velocity.set(0, 0, 0);
    this.object.visible = true;
  }

  /** Called on respawn or round reset. */
  exit(): void {
    this.active = false;
    this.object.visible = false;
  }

  /** A detonation resets the one-action budget. Nothing else does. */
  onDetonation(): void {
    this.actionsLeft = GREMLIN_ACTIONS_PER_CYCLE;
  }

  /**
   * Free flight. No collision: a spectator that can be walled in is worse than
   * one that clips, and the gremlin has no physical presence by design.
   */
  fixedUpdate(dt: number, move: THREE.Vector2, lift: number, yaw: number): void {
    if (!this.active) return;

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    this.velocity.set(
      (-sin * move.y + cos * move.x) * GREMLIN_SPEED,
      lift * GREMLIN_SPEED,
      (-cos * move.y - sin * move.x) * GREMLIN_SPEED,
    );
    this.position.addScaledVector(this.velocity, dt);

    // Kept inside the arena so a gremlin cannot wander off and lose the game.
    this.position.x = THREE.MathUtils.clamp(this.position.x, -ARENA_HALF, ARENA_HALF);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -ARENA_HALF, ARENA_HALF);
    this.position.y = THREE.MathUtils.clamp(this.position.y, GREMLIN_FLOOR, ARENA_CEILING - 1);

    this.smokeTimer = Math.max(0, this.smokeTimer - dt);
  }

  /**
   * Spend the cycle's trigger.
   *
   * @param dronePosition so the gremlin cannot body-block the drone.
   * @returns the action taken, or null if it was refused.
   */
  trigger(action: GremlinAction, dronePosition: THREE.Vector3): GremlinAction | null {
    this.blocked = null;
    if (!this.active) return null;
    if (this.actionsLeft <= 0) {
      this.blocked = 'no trigger left — wait for the next detonation';
      return null;
    }

    // The two hard restrictions from the brief: not on the station, not on the
    // drone. Everything else about targeting is deliberately unrestricted.
    const toStation = Math.hypot(
      this.position.x - EMP_STATION_POSITION[0],
      this.position.z - EMP_STATION_POSITION[1],
    );
    if (toStation <= EMP_STATION_RADIUS + GREMLIN_EXCLUSION_RADIUS) {
      this.blocked = 'too close to the EMP station';
      return null;
    }
    if (this.position.distanceTo(dronePosition) <= GREMLIN_EXCLUSION_RADIUS) {
      this.blocked = 'too close to the drone';
      return null;
    }

    this.actionsLeft -= 1;
    if (action === 'smoke') {
      this.smokeTimer = GREMLIN_SMOKE_TIME;
      this.smoke.position.copy(this.position);
    }
    return action;
  }

  render(frameDelta: number): void {
    if (this.active) {
      this.bobClock += frameDelta;
      this.object.position.set(
        this.position.x,
        this.position.y + Math.sin(this.bobClock * GREMLIN_BOB_HZ * Math.PI * 2) * GREMLIN_BOB,
        this.position.z,
      );
    }

    const material = this.smoke.material as THREE.MeshBasicMaterial;
    this.smoke.visible = this.smokeTimer > 0;
    material.opacity = (this.smokeTimer / GREMLIN_SMOKE_TIME) * SMOKE_OPACITY;
  }

  /** True while a smoke puff is blocking sight lines through it. */
  get smokeActive(): boolean {
    return this.smokeTimer > 0;
  }

  status(): GremlinStatus {
    return { active: this.active, actionsLeft: this.actionsLeft, blocked: this.blocked };
  }
}

const GREMLIN_OPACITY = 0.7;
const GREMLIN_FLOOR = 1.0;
const GREMLIN_BOB = 0.12;
const GREMLIN_BOB_HZ = 0.9;
const SMOKE_OPACITY = 0.55;
