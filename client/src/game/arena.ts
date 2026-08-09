import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import {
  ARENA_CEILING,
  ARENA_HALF,
  ARENA_SIZE,
  BARN,
  BARN_DOOR_HEIGHT,
  BARN_DOOR_WIDTH,
  BARN_ROOF_THICKNESS,
  BARN_WALL_THICKNESS,
  CEILING_THICKNESS,
  CHARGE_PAD_HEIGHT,
  CHARGE_PAD_POSITIONS,
  CHARGE_PAD_RADIUS,
  COLOR_CHARGE_PAD,
  COLOR_EMP_STATION,
  COLOR_GROUND,
  COLOR_HEDGE,
  COLOR_PROP,
  COLOR_WALL,
  COTTAGES,
  CRATE_STAIRS,
  CRATE_STEP_RISE,
  CRATE_STEP_SIZE,
  CYLINDER_SEGMENTS,
  DECAL_Y_OFFSET,
  EMP_STATION_HEIGHT,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  FLOOR_AO_FALLOFF,
  FLOOR_AO_STRENGTH,
  FLOOR_AO_TEXTURE_SIZE,
  GROUND_THICKNESS,
  HEDGES,
  HEDGE_HEIGHT,
  HEDGE_THICKNESS,
  MARKER_RING_WIDTH,
  MARKET_STALLS,
  MOUND_STEPS,
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
  STALL_HEIGHT,
  STALL_SIZE,
  STONE_WALLS,
  STONE_WALL_HEIGHT,
  STONE_WALL_THICKNESS,
  WALL_THICKNESS,
  WINDMILL_RADIUS,
  WINDMILL_TOP,
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
  private readonly hedgeMaterial = new THREE.MeshLambertMaterial({ color: COLOR_HEDGE });

  /**
   * Greybox meshes the art pass may stand in for, by key. Colliders are never
   * in here — session 8's rule is that dressing swaps VISUALS only, and a
   * failed model load must leave the greybox exactly as validated.
   */
  private readonly dressable = new Map<string, THREE.Mesh[]>();

  constructor(
    private readonly physics: Physics,
    private readonly scene: THREE.Scene,
  ) {
    this.buildGround();
    this.buildPerimeter();
    this.buildMound();
    this.buildCottages();
    this.buildBarn();
    this.buildCover();
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
    dressKey?: string,
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
    this.registerDressable(dressKey, mesh);
  }

  private cylinder(
    center: THREE.Vector3Like,
    radius: number,
    height: number,
    material: THREE.Material,
    castShadow = true,
    dressKey?: string,
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
    this.registerDressable(dressKey, mesh);
  }

  private registerDressable(key: string | undefined, mesh: THREE.Mesh): void {
    if (!key) return;
    const list = this.dressable.get(key) ?? [];
    list.push(mesh);
    this.dressable.set(key, list);
  }

  /** Hide a greybox piece whose dressed replacement is now in the scene. */
  concealDressed(key: string): void {
    for (const mesh of this.dressable.get(key) ?? []) mesh.visible = false;
  }

  /** Dev-only: which greybox pieces are still showing, key by key. */
  dressedReport(): Record<string, boolean> {
    const report: Record<string, boolean> = {};
    for (const [key, meshes] of this.dressable) {
      report[key] = meshes.every((mesh) => !mesh.visible);
    }
    return report;
  }

  /**
   * Give a greybox piece a real material instead of hiding it — the windmill
   * tower is a cylinder no modular kit piece can replace, so it keeps its
   * validated geometry and borrows the kit's plaster.
   */
  applyDressedMaterial(key: string, material: THREE.Material): void {
    for (const mesh of this.dressable.get(key) ?? []) mesh.material = material;
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

  /**
   * The windmill mound and tower (handoff 03, section 2): the EMP station is
   * the windmill. Stepped discs keep it approachable from every side — each
   * step is 0.3 m, under the runner's 0.4 m autostep — and the tower stands
   * in the middle of the charge zone, so holding the station means standing
   * exposed on the annulus around it.
   */
  private buildMound(): void {
    for (const [radius, topY] of MOUND_STEPS) {
      this.cylinder({ x: 0, y: topY / 2, z: 0 }, radius, topY, this.propMaterial, false);
    }
    const moundTop = MOUND_STEPS[MOUND_STEPS.length - 1]![1];
    const height = WINDMILL_TOP - moundTop;
    this.cylinder(
      { x: 0, y: moundTop + height / 2, z: 0 },
      WINDMILL_RADIUS,
      height,
      this.wallMaterial,
      true,
      'windmill',
    );
  }

  /**
   * Cottages: solid greybox blocks with flat, walkable roofs in the 6-8 m
   * band. Solid rather than hollow on purpose — session 6 is validating the
   * LAYOUT (sightlines, alleys, roof access), and interiors on every cottage
   * would multiply the surface area to test without changing any of that.
   * The barn is the one traversable interior, below.
   */
  private buildCottages(): void {
    COTTAGES.forEach(([x, z, sizeX, sizeZ, roofY], i) => {
      this.box(
        { x, y: roofY / 2, z },
        { x: sizeX, y: roofY, z: sizeZ },
        this.wallMaterial,
        undefined,
        `cottage${i}`,
      );
    });

    // Crate stairs: each stack rises CRATE_STEP_RISE per box, ending a
    // jumpable gap below its roof. The boxes run from the ground up so the
    // collider is one simple cuboid per step.
    CRATE_STAIRS.forEach(([baseX, baseZ, stepX, stepZ, topY], stair) => {
      const steps = Math.round(topY / CRATE_STEP_RISE);
      for (let i = 0; i < steps; i += 1) {
        const height = CRATE_STEP_RISE * (i + 1);
        this.box(
          // Highest step nearest the building, so the climb runs toward it.
          {
            x: baseX + stepX * (steps - 1 - i),
            y: height / 2,
            z: baseZ + stepZ * (steps - 1 - i),
          },
          { x: CRATE_STEP_SIZE, y: height, z: CRATE_STEP_SIZE },
          this.propMaterial,
          undefined,
          `stairs${stair}`,
        );
      }
    });
  }

  /**
   * The barn: four walls with two door openings and a walkable roof slab.
   * The drone fits through the doors with ~1.2 m to spare on each side of a
   * 1.1 m body, which is exactly the "can enter but must slow down" the
   * handoff asks for; a runner walks in without breaking stride.
   */
  private buildBarn(): void {
    const [x, z, sizeX, sizeZ, wallTop] = BARN;
    const t = BARN_WALL_THICKNESS;
    const doorW = BARN_DOOR_WIDTH;
    const doorH = BARN_DOOR_HEIGHT;

    // North and south walls: solid.
    this.box(
      { x, y: wallTop / 2, z: z - sizeZ / 2 + t / 2 },
      { x: sizeX, y: wallTop, z: t },
      this.wallMaterial,
      undefined,
      'barn',
    );
    this.box(
      { x, y: wallTop / 2, z: z + sizeZ / 2 - t / 2 },
      { x: sizeX, y: wallTop, z: t },
      this.wallMaterial,
      undefined,
      'barn',
    );

    // East and west walls each carry a centred door: two piers plus a lintel.
    for (const side of [-1, 1]) {
      const wallX = x + (side * (sizeX - t)) / 2;
      const pierLength = (sizeZ - doorW) / 2;
      for (const pierSide of [-1, 1]) {
        this.box(
          { x: wallX, y: wallTop / 2, z: z + (pierSide * (doorW + pierLength)) / 2 },
          { x: t, y: wallTop, z: pierLength },
          this.wallMaterial,
          undefined,
          'barn',
        );
      }
      this.box(
        { x: wallX, y: doorH + (wallTop - doorH) / 2, z },
        { x: t, y: wallTop - doorH, z: doorW },
        this.wallMaterial,
        undefined,
        'barn',
      );
    }

    // Roof slab: walkable from the hay-bale stair. Dressed separately from the
    // walls, because its wooden deck survives even if the wall shells fail.
    this.box(
      { x, y: wallTop + BARN_ROOF_THICKNESS / 2, z },
      { x: sizeX, y: BARN_ROOF_THICKNESS, z: sizeZ },
      this.propMaterial,
      undefined,
      'barnRoof',
    );
  }

  /** Stone walls, hedgerows and market stalls: partial cover, all hop-able. */
  private buildCover(): void {
    STONE_WALLS.forEach(([x, z, length, yaw], i) => {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      this.box(
        { x, y: STONE_WALL_HEIGHT / 2, z },
        { x: length, y: STONE_WALL_HEIGHT, z: STONE_WALL_THICKNESS },
        this.wallMaterial,
        rotation,
        `stonewall${i}`,
      );
    });
    HEDGES.forEach(([x, z, length, yaw], i) => {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      this.box(
        { x, y: HEDGE_HEIGHT / 2, z },
        { x: length, y: HEDGE_HEIGHT, z: HEDGE_THICKNESS },
        this.hedgeMaterial,
        rotation,
        `hedge${i}`,
      );
    });
    MARKET_STALLS.forEach(([x, z, yaw], i) => {
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      this.box(
        { x, y: STALL_HEIGHT / 2, z },
        { x: STALL_SIZE, y: STALL_HEIGHT, z: STALL_SIZE },
        this.propMaterial,
        rotation,
        `stall${i}`,
      );
    });
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
