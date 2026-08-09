import * as THREE from 'three';

import { loadAsset } from '../engine/assets';
import {
  ARENA_HALF,
  BARN,
  CHARGE_PAD_POSITIONS,
  CHARGE_PAD_RADIUS,
  COTTAGES,
  EMP_STATION_POSITION,
  MOUND_STEPS,
  RUNNER_SPAWN,
  VILLAGE_GRASS_COUNT,
  VILLAGE_HOUSE_RING,
  VILLAGE_MODULE,
  VILLAGE_PROP_COUNT,
  VILLAGE_TREE_COUNT,
} from '@shared/constants';

/**
 * The village the arena sits in.
 *
 * Purely decorative: NOTHING here gets a collider. The arena's collision
 * layout is tuned — pad spacing, ramp angles, the platform, the tunnel — and
 * dressing it must not move a single surface a player can touch. Everything
 * inside the walls is small enough to walk through (grass, flowers, pebbles)
 * and everything solid-looking is outside them, where nobody can reach it.
 *
 * Built from Kenney's Fantasy Town and Nature kits (CC0). Houses are assembled
 * from a 1x1 module grid rather than shipped whole, so a handful of small
 * meshes makes an entire village.
 *
 * Every piece is drawn with InstancedMesh, one per distinct sub-mesh. Nine
 * houses of thirty pieces each would otherwise be several hundred draw calls;
 * instanced, the whole village costs about as many as it has distinct parts.
 */
export class Village {
  private readonly batches = new Map<string, Batch>();

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * Place one model. Nothing is drawn until `build` runs, because an
   * InstancedMesh needs its count up front.
   */
  private place(model: THREE.Object3D, matrix: THREE.Matrix4): void {
    model.updateWorldMatrix(true, true);
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const key = `${node.geometry.uuid}|${(node.material as THREE.Material).uuid}`;
      let batch = this.batches.get(key);
      if (!batch) {
        batch = { geometry: node.geometry, material: node.material as THREE.Material, matrices: [] };
        this.batches.set(key, batch);
      }
      // Bake the mesh's own transform inside the model into the instance, so a
      // multi-part piece keeps its shape wherever it is placed.
      batch.matrices.push(new THREE.Matrix4().multiplyMatrices(matrix, node.matrixWorld));
    });
  }

  /** Turn everything placed so far into instanced meshes. */
  build(): void {
    for (const batch of this.batches.values()) {
      const source = batch.material as THREE.MeshStandardMaterial;
      // Relit for the same reason the characters are: Kenney ships these unlit,
      // and an unlit village ignores the sun and the fog the arena sits in.
      const material = new THREE.MeshLambertMaterial({
        map: source.map ?? null,
        color: source.color ?? new THREE.Color(0xffffff),
        vertexColors: batch.geometry.hasAttribute('color'),
      });
      const mesh = new THREE.InstancedMesh(batch.geometry, material, batch.matrices.length);
      batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Session 7 culling: a real per-batch bounding sphere (computed over
      // the instances) so the frustum test works, instead of the earlier
      // frustumCulled = false. Looking north culls the batches whose
      // instances all sit south — with buildings in the way, that matters.
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }
    this.batches.clear();
  }

  /**
   * A house on the module grid.
   *
   * Walls are the +X face of a unit tile, so each side of the footprint is the
   * same piece rotated. One tile of the front row is a door and the rest are
   * windows, which is the whole difference between a shed and a home.
   */
  house(
    pieces: Pieces,
    centre: THREE.Vector3,
    tilesX: number,
    tilesZ: number,
    yaw: number,
    scale: number,
    storeys = 1,
  ): void {
    const doorTile = Math.floor(tilesX / 2);
    const base = new THREE.Matrix4().compose(
      centre,
      new THREE.Quaternion().setFromAxisAngle(UP, yaw),
      new THREE.Vector3(scale, scale, scale),
    );

    const originX = -((tilesX - 1) * VILLAGE_MODULE) / 2;
    const originZ = -((tilesZ - 1) * VILLAGE_MODULE) / 2;

    for (let storey = 0; storey < storeys; storey += 1) {
      const y = storey * VILLAGE_MODULE;
      for (let ix = 0; ix < tilesX; ix += 1) {
        for (let iz = 0; iz < tilesZ; iz += 1) {
          if (ix !== 0 && ix !== tilesX - 1 && iz !== 0 && iz !== tilesZ - 1) continue;
          const x = originX + ix * VILLAGE_MODULE;
          const z = originZ + iz * VILLAGE_MODULE;

          // A wall piece IS the +X face of its own tile, so each side of the
          // footprint is the same piece rotated about the tile's centre. It is
          // never offset — offsetting it was what turned the first attempt at
          // this into a scatter of loose panels.
          if (iz === tilesZ - 1) {
            // Front. The ground floor gets the door; upstairs gets a window.
            const front = storey === 0 && ix === doorTile ? pieces.wallDoor : pieces.wallWindow;
            this.tile(base, front, x, y, z, -Math.PI / 2);
          }
          if (iz === 0) this.tile(base, pieces.wall, x, y, z, Math.PI / 2);
          if (ix === tilesX - 1) this.tile(base, pieces.wall, x, y, z, 0);
          if (ix === 0) {
            this.tile(base, storey === 0 ? pieces.wallWindow : pieces.wall, x, y, z, Math.PI);
          }
        }
      }
    }

    // Roof: one tile per footprint square, sat on the top storey. The rows at
    // the front and back are gables so the silhouette has a ridge rather than
    // reading as a flat lid.
    const roofY = storeys * VILLAGE_MODULE;
    for (let ix = 0; ix < tilesX; ix += 1) {
      for (let iz = 0; iz < tilesZ; iz += 1) {
        const x = originX + ix * VILLAGE_MODULE;
        const z = originZ + iz * VILLAGE_MODULE;
        const gable = iz === 0 || iz === tilesZ - 1;
        const piece = gable ? pieces.roofGable : pieces.roof;
        this.tile(base, piece, x, roofY, z, iz === 0 ? Math.PI : 0);
      }
    }
  }

  /** One module-grid piece, positioned in the house's local space. */
  private tile(
    base: THREE.Matrix4,
    model: THREE.Object3D | null,
    x: number,
    y: number,
    z: number,
    rotation: number,
  ): void {
    if (!model) return;
    LOCAL.compose(
      TMP_POS.set(x, y, z),
      TMP_QUAT.setFromAxisAngle(UP, rotation),
      TMP_SCALE.set(1, 1, 1),
    );
    this.place(model, MATRIX.multiplyMatrices(base, LOCAL));
  }

  /** Drop one model at a world position with a yaw and a uniform scale. */
  prop(model: THREE.Object3D | null, x: number, y: number, z: number, yaw: number, scale: number): void {
    if (!model) return;
    MATRIX.compose(
      TMP_POS.set(x, y, z),
      TMP_QUAT.setFromAxisAngle(UP, yaw),
      TMP_SCALE.set(scale, scale, scale),
    );
    this.place(model, MATRIX);
  }
}

interface Batch {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: THREE.Matrix4[];
}

export interface Pieces {
  wall: THREE.Object3D | null;
  wallDoor: THREE.Object3D | null;
  wallWindow: THREE.Object3D | null;
  roof: THREE.Object3D | null;
  roofGable: THREE.Object3D | null;
  fence: THREE.Object3D | null;
  cart: THREE.Object3D | null;
  stall: THREE.Object3D | null;
  lantern: THREE.Object3D | null;
  townTree: THREE.Object3D | null;
  grass: THREE.Object3D | null;
  grassLarge: THREE.Object3D | null;
  flowerRed: THREE.Object3D | null;
  flowerYellow: THREE.Object3D | null;
  tree: THREE.Object3D | null;
  treeBlocks: THREE.Object3D | null;
  stone: THREE.Object3D | null;
}

/**
 * Load every village piece. Missing pieces come back null and are skipped, so
 * a failed fetch costs some scenery and never the game.
 */
export async function loadVillage(): Promise<Pieces> {
  const get = async (name: string): Promise<THREE.Object3D | null> =>
    (await loadAsset(name)).scene;

  const [
    wall, wallDoor, wallWindow, roof, roofGable, fence, cart, stall, lantern, townTree,
    grass, grassLarge, flowerRed, flowerYellow, tree, treeBlocks, stone,
  ] = await Promise.all([
    get('village.wall'), get('village.wallDoor'), get('village.wallWindow'),
    get('village.roof'), get('village.roofGable'), get('village.fence'),
    get('village.cart'), get('village.stall'), get('village.lantern'),
    get('village.townTree'),
    get('village.grass'), get('village.grassLarge'), get('village.flowerRed'),
    get('village.flowerYellow'), get('village.tree'), get('village.treeBlocks'),
    get('village.stone'),
  ]);

  return {
    wall, wallDoor, wallWindow, roof, roofGable, cart, stall, lantern, townTree, fence,
    grass, grassLarge, flowerRed, flowerYellow, tree, treeBlocks, stone,
  };
}

/**
 * Lay the village out around the arena.
 *
 * Deterministic: a seeded generator rather than Math.random, so every client
 * sees the same village and a screenshot taken today matches one taken
 * tomorrow. Nothing here reads or writes game state.
 */
export function dressArena(village: Village, pieces: Pieces): void {
  const rng = seeded(20260809);

  // Houses in a ring outside the walls, facing inward. Out of reach, so they
  // need no colliders and can never interfere with the tuned layout.
  const houses = 9;
  for (let i = 0; i < houses; i += 1) {
    const angle = (i / houses) * Math.PI * 2 + 0.2;
    const radius = VILLAGE_HOUSE_RING + rng() * 8;
    const scale = 3.0 + rng() * 0.7;
    village.house(
      pieces,
      new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius),
      2 + Math.floor(rng() * 2),
      2 + Math.floor(rng() * 2),
      // Face the arena: the wall row carrying the door is the +Z side.
      // The door is on the +Z face, so turn that face toward the arena centre.
      Math.atan2(-Math.cos(angle), -Math.sin(angle)) - Math.PI / 2,
      scale,
      rng() < 0.35 ? 2 : 1,
    );
  }

  // Trees and market clutter filling the gaps between the houses.
  for (let i = 0; i < VILLAGE_TREE_COUNT; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = ARENA_HALF + 8 + rng() * 46;
    const model = rng() < 0.5 ? pieces.tree : pieces.treeBlocks;
    village.prop(model, Math.cos(angle) * radius, 0, Math.sin(angle) * radius, rng() * 6.28, 2.6 + rng() * 1.8);
  }
  for (let i = 0; i < VILLAGE_PROP_COUNT; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = ARENA_HALF + 5 + rng() * 26;
    const roll = rng();
    const model = roll < 0.3 ? pieces.cart : roll < 0.6 ? pieces.stall : roll < 0.8 ? pieces.lantern : pieces.townTree;
    village.prop(model, Math.cos(angle) * radius, 0, Math.sin(angle) * radius, rng() * 6.28, 2.4 + rng() * 0.8);
  }

  // Tall grass, flowers and pebbles INSIDE the arena. Small, walk-through, and
  // kept clear of the pads, the station and the spawn so nothing the player
  // has to read is ever obscured by scenery.
  let placed = 0;
  let attempts = 0;
  while (placed < VILLAGE_GRASS_COUNT && attempts < VILLAGE_GRASS_COUNT * 12) {
    attempts += 1;
    const x = (rng() * 2 - 1) * (ARENA_HALF - 2);
    const z = (rng() * 2 - 1) * (ARENA_HALF - 2);
    if (!isClear(x, z)) continue;
    placed += 1;

    const roll = rng();
    if (roll < 0.55) {
      village.prop(rng() < 0.5 ? pieces.grass : pieces.grassLarge, x, 0, z, rng() * 6.28, 3.4 + rng() * 2.4);
    } else if (roll < 0.8) {
      village.prop(rng() < 0.5 ? pieces.flowerRed : pieces.flowerYellow, x, 0, z, rng() * 6.28, 2.6 + rng() * 1.4);
    } else {
      village.prop(pieces.stone, x, 0, z, rng() * 6.28, 1.6 + rng() * 1.2);
    }
  }

  village.build();
}

/** Keep scenery off anything the player has to see clearly or stand on. */
function isClear(x: number, z: number): boolean {
  for (const [px, pz] of CHARGE_PAD_POSITIONS) {
    if (Math.hypot(x - px, z - pz) < CHARGE_PAD_RADIUS + 2.5) return false;
  }
  // The whole mound, not just the station zone: grass on the windmill's steps
  // reads as the steps being soft ground rather than climbable.
  const moundRadius = Math.max(...MOUND_STEPS.map(([radius]) => radius));
  if (Math.hypot(x - EMP_STATION_POSITION[0], z - EMP_STATION_POSITION[1]) < moundRadius + 1.5) {
    return false;
  }
  if (Math.hypot(x - RUNNER_SPAWN[0], z - RUNNER_SPAWN[2]) < 6) return false;

  // Building footprints, slightly inflated: a tuft clipping through a cottage
  // wall is the kind of detail that makes a greybox read as broken.
  for (const [bx, bz, sizeX, sizeZ] of COTTAGES) {
    if (Math.abs(x - bx) < sizeX / 2 + 1 && Math.abs(z - bz) < sizeZ / 2 + 1) return false;
  }
  if (Math.abs(x - BARN[0]) < BARN[2] / 2 + 1 && Math.abs(z - BARN[1]) < BARN[3] / 2 + 1) {
    return false;
  }
  return true;
}

/**
 * Mulberry32. Deterministic and tiny — the village must be identical on every
 * client, and "identical" is not something Math.random can promise.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const MATRIX = new THREE.Matrix4();
const LOCAL = new THREE.Matrix4();
const TMP_POS = new THREE.Vector3();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
