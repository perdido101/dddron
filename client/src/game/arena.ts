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
  PAD_PULSE_AVAILABLE,
  PAD_PULSE_BLOCKED,
  PAD_PULSE_DEPTH,
  PAD_PULSE_DOCKED,
  PAD_PULSE_SABOTAGED,
  PAD_RING_SPIN,
  PAD_SPIN_AVAILABLE,
  PAD_SPIN_BLOCKED,
  PAD_SPIN_DOCKED,
  PAD_SPIN_SABOTAGED,
  FLOOR_AO_FALLOFF,
  FLOOR_AO_STRENGTH,
  FLOOR_AO_TEXTURE_SIZE,
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
  /** Per-pad spin angle, since each state turns at its own rate. */
  private readonly padSpins: number[] = [];
  private readonly padStates: PadState[] = [];
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
      // Ambient occlusion baked into a runtime-generated map rather than a
      // shipped texture: the walls darken the floor they meet, which is what
      // stops a big flat plane reading as a big flat plane.
      new THREE.MeshLambertMaterial({ color: COLOR_GROUND, map: floorAoTexture() }),
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
    this.padStates[index] = state;
  }

  /**
   * Pad state, told twice: by hue and by movement.
   *
   * Hue alone fails the people it matters most to — roughly one player in
   * twelve cannot separate the green and the red — and it also fails everyone
   * at distance, where a small saturated decal desaturates toward the floor.
   * Motion survives both: free pads turn slowly and steadily, a blocked pad
   * stops dead and breathes, a docked one spins up hard, and a sabotaged one
   * runs backwards and flickers.
   */
  render(frameDelta: number): void {
    this.ringClock += frameDelta;
    for (let i = 0; i < this.padRings.length; i += 1) {
      const ring = this.padRings[i];
      const base = this.padMaterials[i];
      if (!ring || !base) continue;
      const state = this.padStates[i] ?? 'available';

      this.padSpins[i] = (this.padSpins[i] ?? 0) + frameDelta * PAD_RING_SPIN * SPIN_RATE[state];
      ring.rotation.z = this.padSpins[i] ?? 0;

      const hz = PULSE_RATE[state];
      // A steady ring is the calm state; anything pulsing is asking to be read.
      const pulse = hz === 0
        ? 1
        : 1 - PAD_PULSE_DEPTH * (0.5 - 0.5 * Math.cos(this.ringClock * Math.PI * 2 * hz));
      const material = ring.material as THREE.MeshBasicMaterial;
      material.color.copy(base.color).multiplyScalar(pulse);
    }
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

const SPIN_RATE: Record<PadState, number> = {
  available: PAD_SPIN_AVAILABLE,
  blocked: PAD_SPIN_BLOCKED,
  docked: PAD_SPIN_DOCKED,
  sabotaged: PAD_SPIN_SABOTAGED,
};

const PULSE_RATE: Record<PadState, number> = {
  available: PAD_PULSE_AVAILABLE,
  blocked: PAD_PULSE_BLOCKED,
  docked: PAD_PULSE_DOCKED,
  sabotaged: PAD_PULSE_SABOTAGED,
};

/**
 * Floor occlusion, generated once at runtime.
 *
 * A radial-ish falloff from the arena edges, drawn as a greyscale map that
 * multiplies the floor colour. Nothing here is a shipped file — the asset
 * manifest is explicit that anything expressible in code stays in code — and
 * the whole thing is one 256×256 canvas built at boot.
 */
let floorAo: THREE.Texture | null = null;

function floorAoTexture(): THREE.Texture {
  if (floorAo) return floorAo;
  const size = FLOOR_AO_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context) {
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Distance from the nearest edge, normalised to the half-extent.
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y) / (size / 2);
        // Darkest hard against a wall, clean by FLOOR_AO_FALLOFF inward.
        const occlusion = 1 - FLOOR_AO_STRENGTH * (1 - Math.min(edge / FLOOR_AO_FALLOFF, 1));
        const value = Math.round(occlusion * 255);
        const i = (y * size + x) * 4;
        image.data[i] = value;
        image.data[i + 1] = value;
        image.data[i + 2] = value;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }
  floorAo = new THREE.CanvasTexture(canvas);
  floorAo.colorSpace = THREE.SRGBColorSpace;
  return floorAo;
}
