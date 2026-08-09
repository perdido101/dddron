import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  ARENA_CEILING,
  ARENA_HALF,
  ARENA_SIZE,
  CEILING_THICKNESS,
  CHARGE_PAD_HEIGHT,
  CHARGE_PAD_POSITIONS,
  CHARGE_PAD_RADIUS,
  COLOR_CHARGE_PAD,
  COLOR_EMP_STATION,
  COLOR_GROUND,
  COLOR_PROP,
  COLOR_WALL,
  CYLINDER_SEGMENTS,
  DECAL_Y_OFFSET,
  EMP_STATION_HEIGHT,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  GROUND_THICKNESS,
  LEDGE,
  MARKER_RING_WIDTH,
  PAD_COLOR_AVAILABLE,
  PAD_COLOR_BLOCKED,
  PAD_COLOR_DOCKED,
  PAD_COLOR_SABOTAGED,
  PAD_RING_SPIN,
  PILLARS,
  PLATFORM,
  RAMPS,
  RAMP_THICKNESS,
  TUNNEL,
  TUNNEL_ROOF_THICKNESS,
  TUNNEL_WALL_THICKNESS,
  WALL_THICKNESS,
} from '@shared/constants';

import type { Physics } from '../engine/physics';

/**
 * The grey-box arena: static geometry only, built once from the constants in
 * /shared. Every mesh here has a matching fixed collider — nothing is
 * decorative unless it is flat on the floor.
 */
export type PadState = 'available' | 'blocked' | 'docked' | 'sabotaged';

export class Arena {
  /** One material per pad, so each can show its own state. */
  private readonly padMaterials: THREE.MeshLambertMaterial[] = [];
  private readonly padRings: THREE.Mesh[] = [];
  private ringClock = 0;

  private readonly wallMaterial = new THREE.MeshLambertMaterial({ color: COLOR_WALL });
  private readonly propMaterial = new THREE.MeshLambertMaterial({ color: COLOR_PROP });

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
  ) {
    this.buildGround();
    this.buildPerimeter();
    this.buildPlatforms();
    this.buildRamps();
    this.buildPillars();
    this.buildTunnel();
    this.buildMarkers();
  }

  /**
   * Add a static box. Position is the box centre; size is the full extent.
   * Meshes are optional so invisible bounds (the ceiling) can share the path.
   */
  private box(
    center: THREE.Vector3Like,
    size: THREE.Vector3Like,
    material: THREE.Material | null,
    rotation?: THREE.Quaternion,
  ): void {
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z),
    );
    if (rotation) {
      body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, false);
    }
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2),
      body,
    );

    if (!material) return;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    mesh.position.set(center.x, center.y, center.z);
    if (rotation) mesh.quaternion.copy(rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private cylinder(
    center: THREE.Vector3Like,
    radius: number,
    height: number,
    material: THREE.Material,
    castShadow = true,
  ): void {
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z),
    );
    this.physics.world.createCollider(RAPIER.ColliderDesc.cylinder(height / 2, radius), body);

    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, CYLINDER_SEGMENTS),
      material,
    );
    mesh.position.set(center.x, center.y, center.z);
    // Flat floor markers self-shadow into dark blobs if they cast: a 14 cm disc
    // casts a shadow onto its own top face and the bias cannot separate them.
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildGround(): void {
    // Ground surface sits at y = 0; the slab hangs below it.
    this.box(
      { x: 0, y: -GROUND_THICKNESS / 2, z: 0 },
      { x: ARENA_SIZE, y: GROUND_THICKNESS, z: ARENA_SIZE },
      null,
    );

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
      new THREE.MeshLambertMaterial({ color: COLOR_GROUND }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(ARENA_SIZE, ARENA_SIZE, COLOR_WALL, COLOR_WALL);
    grid.position.y = DECAL_Y_OFFSET;
    grid.material.opacity = 0.28;
    grid.material.transparent = true;
    this.scene.add(grid);
  }

  private buildPerimeter(): void {
    const wallCenter = ARENA_HALF + WALL_THICKNESS / 2;
    const span = ARENA_SIZE + WALL_THICKNESS * 2;
    const wallSizeX = { x: WALL_THICKNESS, y: ARENA_CEILING, z: span };
    const wallSizeZ = { x: span, y: ARENA_CEILING, z: WALL_THICKNESS };
    const y = ARENA_CEILING / 2;

    this.box({ x: wallCenter, y, z: 0 }, wallSizeX, this.wallMaterial);
    this.box({ x: -wallCenter, y, z: 0 }, wallSizeX, this.wallMaterial);
    this.box({ x: 0, y, z: wallCenter }, wallSizeZ, this.wallMaterial);
    this.box({ x: 0, y, z: -wallCenter }, wallSizeZ, this.wallMaterial);

    // Ceiling: collision only. Drawing it would just black out the view.
    this.box(
      { x: 0, y: ARENA_CEILING + CEILING_THICKNESS / 2, z: 0 },
      { x: span, y: CEILING_THICKNESS, z: span },
      null,
    );
  }

  private buildPlatforms(): void {
    for (const [x, z, sizeX, sizeZ, topY] of [PLATFORM, LEDGE]) {
      this.box(
        { x, y: topY / 2, z },
        { x: sizeX, y: topY, z: sizeZ },
        this.propMaterial,
      );
    }
  }

  /**
   * Ramps are thin slabs tilted about their climb axis. Local +x is the climb
   * direction; `yaw` rotates that direction into the world.
   */
  private buildRamps(): void {
    for (const [x, z, run, width, rise, yaw] of RAMPS) {
      const pitch = Math.atan2(rise, run);
      const slopeLength = Math.hypot(run, rise);
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, pitch, 'YZX'));
      // Drop the slab by half its thickness measured vertically, so the WALKING
      // SURFACE meets the floor at the foot and the platform top at the head.
      // Lifting instead leaves a step at the foot that autostep cannot clear,
      // which silently walls the ramp off.
      const verticalDrop = RAMP_THICKNESS / 2 / Math.cos(pitch);
      this.box(
        { x, y: rise / 2 - verticalDrop, z },
        { x: slopeLength, y: RAMP_THICKNESS, z: width },
        this.propMaterial,
        rotation,
      );
    }
  }

  private buildPillars(): void {
    for (const [x, z, radius, height] of PILLARS) {
      this.cylinder({ x, y: height / 2, z }, radius, height, this.propMaterial);
    }
  }

  /** Two side walls plus a roof slab. Local +x runs along the tunnel. */
  private buildTunnel(): void {
    const [x, z, length, width, clearance, yaw] = TUNNEL;
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    const offset = new THREE.Vector3();

    for (const side of [-1, 1]) {
      offset.set(0, 0, (side * (width + TUNNEL_WALL_THICKNESS)) / 2).applyQuaternion(rotation);
      this.box(
        { x: x + offset.x, y: clearance / 2, z: z + offset.z },
        { x: length, y: clearance, z: TUNNEL_WALL_THICKNESS },
        this.wallMaterial,
        rotation,
      );
    }

    this.box(
      { x, y: clearance + TUNNEL_ROOF_THICKNESS / 2, z },
      { x: length, y: TUNNEL_ROOF_THICKNESS, z: width + TUNNEL_WALL_THICKNESS * 2 },
      this.propMaterial,
      rotation,
    );
  }

  /**
   * Charge pads and the EMP station. Flat markers with a low kerb — they read
   * as objective sites now and become real gameplay volumes in phases 3-4.
   */
  private buildMarkers(): void {
    for (const [x, z] of CHARGE_PAD_POSITIONS) {
      const padMaterial = new THREE.MeshLambertMaterial({ color: COLOR_CHARGE_PAD });
      this.padMaterials.push(padMaterial);
      this.cylinder({ x, y: CHARGE_PAD_HEIGHT / 2, z }, CHARGE_PAD_RADIUS, CHARGE_PAD_HEIGHT, padMaterial, false);
      this.padRings.push(this.addRing(x, z, CHARGE_PAD_RADIUS, COLOR_CHARGE_PAD));
    }

    const [stationX, stationZ] = EMP_STATION_POSITION;
    this.cylinder(
      { x: stationX, y: EMP_STATION_HEIGHT / 2, z: stationZ },
      EMP_STATION_RADIUS,
      EMP_STATION_HEIGHT,
      new THREE.MeshLambertMaterial({ color: COLOR_EMP_STATION }),
      false,
    );
    this.addRing(stationX, stationZ, EMP_STATION_RADIUS, COLOR_EMP_STATION);
  }

  /** Painted floor ring around an objective site. Visual only. */
  /**
   * Pad state, straight from the asset manifest: green available, red
   * core-blocked, blue drone docked, grey sabotaged. This is how a runner reads
   * the board at a glance without any UI.
   */
  setPadState(index: number, state: PadState): void {
    const material = this.padMaterials[index];
    if (!material) return;
    material.color.setHex(
      state === 'blocked' ? PAD_COLOR_BLOCKED
        : state === 'docked' ? PAD_COLOR_DOCKED
        : state === 'sabotaged' ? PAD_COLOR_SABOTAGED
        : PAD_COLOR_AVAILABLE,
    );
    const ring = this.padRings[index];
    if (ring) (ring.material as THREE.MeshBasicMaterial).color.copy(material.color);
  }

  /** Slow ring rotation, so a live pad never looks like a painted decal. */
  render(frameDelta: number): void {
    this.ringClock += frameDelta * PAD_RING_SPIN;
    for (const ring of this.padRings) ring.rotation.z = this.ringClock;
  }

  private addRing(x: number, z: number, radius: number, color: number): THREE.Mesh {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius + MARKER_RING_WIDTH, CYLINDER_SEGMENTS),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, DECAL_Y_OFFSET, z);
    this.scene.add(ring);
    return ring;
  }
}
