import * as THREE from 'three';

import { loadAsset } from '../engine/assets';
import {
  ARENA_HALF,
  BARN,
  BARN_DOOR_HEIGHT,
  BARN_DOOR_WIDTH,
  CHARGE_PAD_POSITIONS,
  CHARGE_PAD_RADIUS,
  COTTAGES,
  CRATE_STAIRS,
  CRATE_STEP_RISE,
  CRATE_STEP_SIZE,
  EMP_STATION_POSITION,
  FAN_POSITIONS,
  HEDGES,
  MARKET_STALLS,
  MOUND_STEPS,
  RUNNER_SPAWN,
  STONE_WALLS,
  STONE_WALL_HEIGHT,
  VILLAGE_GRASS_COUNT,
  VILLAGE_HOUSE_RING,
  VILLAGE_MODULE,
  VILLAGE_PROP_COUNT,
  VILLAGE_TREE_COUNT,
  WINDMILL_RADIUS,
  WINDMILL_TOP,
} from '@shared/constants';

import type { Arena } from './arena';
import type { Hazards } from './hazards';

/**
 * The village, dressed (session 8).
 *
 * Everything visual comes from ONE environment family — the Quaternius
 * Medieval Village + Stylized Nature MegaKits (CC0) — per handoff 03's
 * "one source for the environment, full stop". Two layers:
 *
 * - OUTSIDE the arena: pure decoration, no colliders, pitched roofs and all,
 *   because nobody can stand on them.
 * - INSIDE the arena: costume over the validated greybox. Colliders are never
 *   touched; assemblies trace the exact collider footprints from /shared and
 *   then ask the arena to hide the greybox mesh they replace. Walkable roofs
 *   stay FLAT — a pitched roof over a flat collider would swallow a standing
 *   runner — so cottages read as stone shells with timber roof decks.
 *
 * Every piece is drawn with InstancedMesh, one per distinct sub-mesh, so the
 * whole village costs about as many draw calls as it has distinct parts.
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
      // The loader already forced Lambert, but instancing rebuilds materials,
      // so carry the map/colour over rather than trusting the source type —
      // and the foliage flags with them, or every instanced leaf goes black.
      const material = new THREE.MeshLambertMaterial({
        map: source.map ?? null,
        color: source.color ?? new THREE.Color(0xffffff),
        vertexColors: source.vertexColors === true,
        side: source.side ?? THREE.FrontSide,
        alphaTest: source.alphaTest > 0 ? source.alphaTest : source.transparent ? 0.5 : 0,
      });
      const mesh = new THREE.InstancedMesh(batch.geometry, material, batch.matrices.length);
      batch.matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Real per-batch bounding spheres (session 7): the frustum test works,
      // so looking north culls the batches that sit entirely south.
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
    }
    this.batches.clear();
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

  /** One piece under an arbitrary affine, for the assembly helpers below. */
  piece(model: THREE.Object3D | null, matrix: THREE.Matrix4): void {
    if (!model) return;
    this.place(model, matrix);
  }
}

interface Batch {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: THREE.Matrix4[];
}

/** Every manifest entry the village uses, loaded up front. */
const PIECE_NAMES = [
  'wallPlaster', 'wallPlasterDoor', 'wallPlasterWindow',
  'wallBrick', 'wallBrickDoor', 'wallBrickWindow',
  'roofSmall', 'roofMedium', 'roofLarge', 'roofTower', 'roofPlank',
  'floorWood', 'stairs', 'crate', 'wagon', 'chimney',
  'fence', 'fenceLong', 'border',
  'tree1', 'tree2', 'tree3', 'pine1', 'pine2', 'treeLandmark',
  'bush', 'bushFlowers', 'grassShort', 'grassTall', 'grassWispy',
  'flowerPink', 'flowerTall', 'clover', 'rock', 'pebble',
] as const;

export type PieceName = (typeof PIECE_NAMES)[number];
export type Pieces = Record<PieceName, THREE.Object3D | null>;

/**
 * Load every village piece. Missing pieces come back null and are skipped, so
 * a failed fetch costs some scenery and never the game.
 */
export async function loadVillage(): Promise<Pieces> {
  const loaded = await Promise.all(
    PIECE_NAMES.map(async (name) => (await loadAsset(`village.${name}`)).scene),
  );
  const pieces = {} as Pieces;
  PIECE_NAMES.forEach((name, i) => {
    pieces[name] = loaded[i] ?? null;
  });
  return pieces;
}

/** Native dimensions of the kit's modules (measured from the GLTFs). */
const WALL_HEIGHT = 3.12;
const ROOF_SKIRT = 0.52;
const TOWER_ROOF = { width: 5.65, height: 6.79, skirt: 0.57 };
const CRATE_SIZE = 1.07;
const PLANK_LENGTH = 2.26;

/**
 * A rectangle of wall modules: the shell every dressed building shares.
 *
 * Modules are 2 m wide; each side gets however many fit, stretched to land
 * exactly on the footprint. `door` names the outward side that gets one
 * (ground floor, middle module); windows alternate on the rest.
 */
function shell(
  village: Village,
  pieces: Pieces,
  brick: boolean,
  centre: THREE.Vector3,
  sizeX: number,
  sizeZ: number,
  height: number,
  door: 'north' | 'south' | 'east' | 'west' | null,
): boolean {
  const plain = brick ? pieces.wallBrick : pieces.wallPlaster;
  const doorWall = brick ? pieces.wallBrickDoor : pieces.wallPlasterDoor;
  const windowWall = brick ? pieces.wallBrickWindow : pieces.wallPlasterWindow;
  if (!plain) return false;

  const storeys = Math.max(1, Math.round(height / WALL_HEIGHT));
  const scaleY = height / (storeys * WALL_HEIGHT);

  // Each entry: [sideName, yaw of an outward-facing panel, run direction].
  const sides: [string, number, THREE.Vector3, THREE.Vector3, number][] = [
    ['south', 0, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), sizeX],
    ['north', Math.PI, new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), sizeX],
    ['east', Math.PI / 2, new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), sizeZ],
    ['west', -Math.PI / 2, new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), sizeZ],
  ];

  for (const [name, yaw, run, out, length] of sides) {
    const modules = Math.max(1, Math.round(length / VILLAGE_MODULE));
    const segment = length / modules;
    const doorModule = Math.floor(modules / 2);
    // Panels sit just inside the collider face so the greybox swap never
    // grows the building past the surface players slide along.
    const half = name === 'south' || name === 'north' ? sizeZ / 2 : sizeX / 2;

    for (let storey = 0; storey < storeys; storey += 1) {
      for (let i = 0; i < modules; i += 1) {
        let model = i % 2 === 1 ? windowWall ?? plain : plain;
        if (storey === 0 && door === name && i === doorModule) model = doorWall ?? plain;
        const along = -length / 2 + (i + 0.5) * segment;
        MATRIX.compose(
          TMP_POS.set(
            centre.x + run.x * along + out.x * (half - PANEL_INSET),
            storey * WALL_HEIGHT * scaleY,
            centre.z + run.z * along + out.z * (half - PANEL_INSET),
          ),
          TMP_QUAT.setFromAxisAngle(UP, yaw),
          TMP_SCALE.set(segment / VILLAGE_MODULE, scaleY, 1),
        );
        village.piece(model, MATRIX);
      }
    }
  }
  return true;
}

/** A flat, walkable timber deck with a stone lip, at the collider's top. */
function deck(
  village: Village,
  pieces: Pieces,
  centre: THREE.Vector3,
  sizeX: number,
  sizeZ: number,
  y: number,
): void {
  if (pieces.floorWood) {
    const nx = Math.max(1, Math.round(sizeX / 2));
    const nz = Math.max(1, Math.round(sizeZ / 2));
    for (let ix = 0; ix < nx; ix += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        MATRIX.compose(
          TMP_POS.set(
            centre.x - sizeX / 2 + (ix + 0.5) * (sizeX / nx),
            y + DECK_LIFT,
            centre.z - sizeZ / 2 + (iz + 0.5) * (sizeZ / nz),
          ),
          TMP_QUAT.identity(),
          TMP_SCALE.set(sizeX / nx / 2, 1, sizeZ / nz / 2),
        );
        village.piece(pieces.floorWood, MATRIX);
      }
    }
  }

  // Stone border as a parapet lip round the deck edge.
  if (!pieces.border) return;
  const edges: [number, number, number, number][] = [
    [centre.x, centre.z - sizeZ / 2, 0, sizeX],
    [centre.x, centre.z + sizeZ / 2, Math.PI, sizeX],
    [centre.x - sizeX / 2, centre.z, Math.PI / 2, sizeZ],
    [centre.x + sizeX / 2, centre.z, -Math.PI / 2, sizeZ],
  ];
  for (const [x, z, yaw, length] of edges) {
    MATRIX.compose(
      TMP_POS.set(x, y + DECK_LIFT, z),
      TMP_QUAT.setFromAxisAngle(UP, yaw),
      TMP_SCALE.set(length / 2, 1.6, 0.45),
    );
    village.piece(pieces.border, MATRIX);
  }
}

/**
 * Dress the structures INSIDE the arena over their greybox colliders.
 *
 * Each assembly hides its greybox counterpart only after being placed, so a
 * missing model keeps the validated grey shape instead of leaving a hole.
 */
export function dressStructures(
  village: Village,
  pieces: Pieces,
  arena: Arena,
  hazards: Hazards,
): void {
  // Cottages: stone/plaster shells to the exact collider height, flat timber
  // decks (the roofs are walkable), chimneys for the skyline.
  COTTAGES.forEach(([x, z, sizeX, sizeZ, roofY], i) => {
    const centre = new THREE.Vector3(x, 0, z);
    const brick = i % 3 === 1;
    const door = Math.abs(x) > Math.abs(z) ? (x > 0 ? 'west' : 'east') : z > 0 ? 'south' : 'north';
    if (!shell(village, pieces, brick, centre, sizeX, sizeZ, roofY, door)) return;
    deck(village, pieces, centre, sizeX, sizeZ, roofY);
    if (pieces.chimney && i % 2 === 0) {
      village.prop(pieces.chimney, x + sizeX / 2 - 0.8, roofY, z - sizeZ / 2 + 0.8, 0, 0.7);
    }
    arena.concealDressed(`cottage${i}`);
  });

  // The barn: brick, with the door gaps the colliders already carry. The
  // shell helper cannot cut holes, so the barn is assembled wall by wall on
  // the same pier/lintel layout buildBarn used.
  dressBarn(village, pieces, arena);

  // Stone walls: brick modules squashed to knee height.
  if (pieces.wallBrick) {
    STONE_WALLS.forEach(([x, z, length, yaw], i) => {
      const modules = Math.max(1, Math.round(length / VILLAGE_MODULE));
      const dir = TMP_POS.set(Math.cos(yaw), 0, -Math.sin(yaw)).clone();
      for (let m = 0; m < modules; m += 1) {
        const along = -length / 2 + (m + 0.5) * (length / modules);
        MATRIX.compose(
          new THREE.Vector3(x + dir.x * along, 0, z + dir.z * along),
          TMP_QUAT.setFromAxisAngle(UP, yaw),
          TMP_SCALE.set(length / modules / VILLAGE_MODULE, STONE_WALL_HEIGHT / WALL_HEIGHT, 1),
        );
        village.piece(pieces.wallBrick, MATRIX);
      }
      arena.concealDressed(`stonewall${i}`);
    });
  }

  // Hedgerows: a run of bushes. They bulge a little past the thin collider,
  // which reads as foliage you brush through rather than a wall that lies.
  if (pieces.bush) {
    HEDGES.forEach(([x, z, length, yaw], i) => {
      const count = Math.max(2, Math.round(length / 1.4));
      const dirX = Math.cos(yaw);
      const dirZ = -Math.sin(yaw);
      for (let b = 0; b < count; b += 1) {
        const along = -length / 2 + (b + 0.5) * (length / count);
        const model = b % 3 === 2 ? pieces.bushFlowers ?? pieces.bush : pieces.bush;
        village.prop(
          model,
          x + dirX * along,
          0,
          z + dirZ * along,
          (b * 1.7) % 6.28,
          1.0 + ((b * 37) % 10) / 40,
        );
      }
      arena.concealDressed(`hedge${i}`);
    });
  }

  // Market stalls: crate pairs under a plank canopy.
  if (pieces.crate && pieces.roofPlank) {
    MARKET_STALLS.forEach(([x, z, yaw], i) => {
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      for (const side of [-0.45, 0.45]) {
        village.prop(pieces.crate, x + cos * side, 0, z - sin * side, yaw, 0.82);
      }
      MATRIX.compose(
        TMP_POS.set(x, 1.55, z),
        TMP_QUAT.setFromAxisAngle(UP, yaw),
        TMP_SCALE.set(2.4 / PLANK_LENGTH, 1.0, 1.5),
      );
      village.piece(pieces.roofPlank, MATRIX);
      arena.concealDressed(`stall${i}`);
    });
  }

  // Crate stairs: each collider step becomes a column of crates, squashed so
  // the stack tops out exactly where the collider does.
  if (pieces.crate) {
    CRATE_STAIRS.forEach(([baseX, baseZ, stepX, stepZ, topY], stair) => {
      const steps = Math.round(topY / CRATE_STEP_RISE);
      for (let i = 0; i < steps; i += 1) {
        const height = CRATE_STEP_RISE * (i + 1);
        const x = baseX + stepX * (steps - 1 - i);
        const z = baseZ + stepZ * (steps - 1 - i);
        const crates = Math.max(1, Math.round(height / (CRATE_SIZE * 1.4)));
        const each = height / crates;
        for (let c = 0; c < crates; c += 1) {
          MATRIX.compose(
            TMP_POS.set(x, c * each, z),
            TMP_QUAT.setFromAxisAngle(UP, ((stair * 5 + i * 3 + c) % 7) * 0.09 - 0.27),
            TMP_SCALE.set(CRATE_STEP_SIZE / CRATE_SIZE, each / CRATE_SIZE, CRATE_STEP_SIZE / CRATE_SIZE),
          );
          village.piece(pieces.crate, MATRIX);
        }
      }
      arena.concealDressed(`stairs${stair}`);
    });
  }

  dressWindmill(village, pieces, arena, hazards);
}

/** The barn shell, tracing buildBarn's pier-and-lintel layout exactly. */
function dressBarn(village: Village, pieces: Pieces, arena: Arena): void {
  if (!pieces.wallBrick) return;
  const [x, z, sizeX, sizeZ, wallTop] = BARN;
  const doorW = BARN_DOOR_WIDTH;
  const storeys = Math.max(1, Math.round(wallTop / WALL_HEIGHT));
  const scaleY = wallTop / (storeys * WALL_HEIGHT);

  const panel = (px: number, pz: number, yaw: number, width: number, y0: number, height: number): void => {
    MATRIX.compose(
      TMP_POS.set(px, y0, pz),
      TMP_QUAT.setFromAxisAngle(UP, yaw),
      TMP_SCALE.set(width / VILLAGE_MODULE, height / WALL_HEIGHT, 1),
    );
    village.piece(pieces.wallBrick, MATRIX);
  };

  for (let storey = 0; storey < storeys; storey += 1) {
    const y0 = storey * WALL_HEIGHT * scaleY;
    const h = WALL_HEIGHT * scaleY;
    // North and south: solid runs of modules with the odd window.
    for (const [face, yaw] of [
      [z - sizeZ / 2 + PANEL_INSET, Math.PI],
      [z + sizeZ / 2 - PANEL_INSET, 0],
    ] as const) {
      const modules = Math.max(1, Math.round(sizeX / VILLAGE_MODULE));
      for (let i = 0; i < modules; i += 1) {
        const along = -sizeX / 2 + (i + 0.5) * (sizeX / modules);
        const model = i % 2 === 1 ? pieces.wallBrickWindow ?? pieces.wallBrick : pieces.wallBrick;
        MATRIX.compose(
          TMP_POS.set(x + along, y0, face),
          TMP_QUAT.setFromAxisAngle(UP, yaw),
          TMP_SCALE.set(sizeX / modules / VILLAGE_MODULE, h / WALL_HEIGHT, 1),
        );
        village.piece(model, MATRIX);
      }
    }
    // East and west: two piers and a lintel around each centred door.
    for (const side of [-1, 1]) {
      const wallX = x + side * (sizeX / 2 - PANEL_INSET);
      const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      const pierLength = (sizeZ - doorW) / 2;
      for (const pierSide of [-1, 1]) {
        panel(wallX, z + (pierSide * (doorW + pierLength)) / 2, yaw, pierLength, y0, h);
      }
    }
  }
  // Lintels above the doors.
  for (const side of [-1, 1]) {
    const wallX = x + side * (sizeX / 2 - PANEL_INSET);
    const yaw = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    panel(wallX, z, yaw, doorW, BARN_DOOR_HEIGHT, wallTop - BARN_DOOR_HEIGHT);
  }

  deck(village, pieces, new THREE.Vector3(x, 0, z), sizeX, sizeZ, wallTop);
  arena.concealDressed('barn');
  arena.concealDressed('barnRoof');
}

/**
 * The windmill IS the EMP station (handoff 03, section 2). The tower keeps
 * its validated cylinder and borrows the kit's plaster; the cap is the kit's
 * tower roof; the sails are kit planks on the rotor hazard's own transform.
 */
function dressWindmill(village: Village, pieces: Pieces, arena: Arena, hazards: Hazards): void {
  const plasterSource = pieces.wallPlaster;
  if (plasterSource) {
    let material: THREE.MeshLambertMaterial | null = null;
    plasterSource.traverse((node) => {
      if (material || !(node instanceof THREE.Mesh)) return;
      const source = node.material as THREE.MeshLambertMaterial;
      material = source.clone();
      if (material.map) {
        material.map = material.map.clone();
        material.map.wrapS = THREE.RepeatWrapping;
        material.map.wrapT = THREE.RepeatWrapping;
        material.map.repeat.set(3, 2);
      }
    });
    if (material) arena.applyDressedMaterial('windmill', material);
  }

  if (pieces.roofTower) {
    const scaleXZ = ((WINDMILL_RADIUS + 0.55) * 2) / TOWER_ROOF.width;
    const scaleeY = 3.1 / TOWER_ROOF.height;
    MATRIX.compose(
      TMP_POS.set(0, WINDMILL_TOP + TOWER_ROOF.skirt * scaleeY - 0.1, 0),
      TMP_QUAT.identity(),
      TMP_SCALE.set(scaleXZ, scaleeY, scaleXZ),
    );
    village.piece(pieces.roofTower, MATRIX);
  }

  // A door into the tower, facing the spawn side, so it reads as a building
  // someone works in rather than a pillar.
  const moundTop = MOUND_STEPS[MOUND_STEPS.length - 1]?.[1] ?? 0;
  if (pieces.wallPlasterDoor) {
    MATRIX.compose(
      TMP_POS.set(0, moundTop, WINDMILL_RADIUS - 0.35),
      TMP_QUAT.setFromAxisAngle(UP, 0),
      TMP_SCALE.set(0.8, 0.75, 1),
    );
    village.piece(pieces.wallPlasterDoor, MATRIX);
  }

  // Sails on every rotor: index 0 is the windmill, the rest are the barn's
  // extractor fans, which get the same treatment at their own radius.
  if (pieces.roofPlank) {
    for (let i = 0; i < FAN_POSITIONS.length; i += 1) hazards.dressFan(i, pieces.roofPlank);
  }
}

/**
 * Lay the decorative village out around the arena.
 *
 * Deterministic: a seeded generator rather than Math.random, so every client
 * sees the same village and a screenshot taken today matches one taken
 * tomorrow. Nothing here reads or writes game state.
 */
export function dressArena(village: Village, pieces: Pieces): void {
  const rng = seeded(20260809);

  // Houses in a ring outside the walls, facing inward. Out of reach, so they
  // need no colliders — and being decoration, they may keep pitched roofs.
  const houses = 9;
  for (let i = 0; i < houses; i += 1) {
    const angle = (i / houses) * Math.PI * 2 + 0.2;
    const radius = VILLAGE_HOUSE_RING + rng() * 8;
    ringHouse(
      village,
      pieces,
      new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius),
      2 + Math.floor(rng() * 2),
      2 + Math.floor(rng() * 2),
      angle + Math.PI / 2 + (rng() - 0.5) * 0.4,
      rng() < 0.35 ? 2 : 1,
      rng() < 0.4,
    );
  }

  // Trees filling the gaps between the houses. One twisted landmark tree.
  village.prop(pieces.treeLandmark, -VILLAGE_HOUSE_RING - 14, 0, 10, 0.6, 1.1);
  const trees = [pieces.tree1, pieces.tree2, pieces.tree3, pieces.pine1, pieces.pine2];
  for (let i = 0; i < VILLAGE_TREE_COUNT; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = ARENA_HALF + 8 + rng() * 46;
    const model = trees[Math.floor(rng() * trees.length)] ?? null;
    village.prop(model, Math.cos(angle) * radius, 0, Math.sin(angle) * radius, rng() * 6.28, 0.9 + rng() * 0.5);
  }
  for (let i = 0; i < VILLAGE_PROP_COUNT; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = ARENA_HALF + 5 + rng() * 26;
    const roll = rng();
    const model = roll < 0.3 ? pieces.wagon : roll < 0.6 ? pieces.fence : roll < 0.8 ? pieces.crate : pieces.rock;
    village.prop(model, Math.cos(angle) * radius, 0, Math.sin(angle) * radius, rng() * 6.28, 0.9 + rng() * 0.4);
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
      const grass = roll < 0.2 ? pieces.grassWispy : roll < 0.38 ? pieces.grassTall : pieces.grassShort;
      village.prop(grass, x, 0, z, rng() * 6.28, 0.8 + rng() * 0.5);
    } else if (roll < 0.8) {
      const flower = rng() < 0.5 ? pieces.flowerPink : rng() < 0.5 ? pieces.flowerTall : pieces.clover;
      village.prop(flower, x, 0, z, rng() * 6.28, 0.7 + rng() * 0.4);
    } else {
      village.prop(pieces.pebble, x, 0, z, rng() * 6.28, 1.2 + rng() * 1.4);
    }
  }

  village.build();
}

/** A decorative house outside the walls: shell plus a real pitched roof. */
function ringHouse(
  village: Village,
  pieces: Pieces,
  centre: THREE.Vector3,
  tilesX: number,
  tilesZ: number,
  yaw: number,
  storeys: number,
  brick: boolean,
): void {
  const sizeX = tilesX * VILLAGE_MODULE;
  const sizeZ = tilesZ * VILLAGE_MODULE;
  const height = storeys * WALL_HEIGHT;

  // The shell helper works in axis-aligned world space; a decorative house
  // rotates freely, so its pieces go through a yawed base matrix instead.
  const base = new THREE.Matrix4().compose(
    centre,
    new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    new THREE.Vector3(1, 1, 1),
  );
  const plain = brick ? pieces.wallBrick : pieces.wallPlaster;
  const doorWall = brick ? pieces.wallBrickDoor : pieces.wallPlasterDoor;
  const windowWall = brick ? pieces.wallBrickWindow : pieces.wallPlasterWindow;
  if (!plain) return;

  const localSides: { yaw: number; run: THREE.Vector3; out: THREE.Vector3; length: number; door: boolean }[] = [
    { yaw: 0, run: new THREE.Vector3(1, 0, 0), out: new THREE.Vector3(0, 0, 1), length: sizeX, door: true },
    { yaw: Math.PI, run: new THREE.Vector3(-1, 0, 0), out: new THREE.Vector3(0, 0, -1), length: sizeX, door: false },
    { yaw: Math.PI / 2, run: new THREE.Vector3(0, 0, -1), out: new THREE.Vector3(1, 0, 0), length: sizeZ, door: false },
    { yaw: -Math.PI / 2, run: new THREE.Vector3(0, 0, 1), out: new THREE.Vector3(-1, 0, 0), length: sizeZ, door: false },
  ];

  for (const side of localSides) {
    const modules = Math.max(1, Math.round(side.length / VILLAGE_MODULE));
    const doorModule = Math.floor(modules / 2);
    const half = side.out.z !== 0 ? sizeZ / 2 : sizeX / 2;
    for (let storey = 0; storey < storeys; storey += 1) {
      for (let i = 0; i < modules; i += 1) {
        let model = i % 2 === 1 ? windowWall ?? plain : plain;
        if (storey === 0 && side.door && i === doorModule) model = doorWall ?? plain;
        const along = -side.length / 2 + (i + 0.5) * (side.length / modules);
        LOCAL.compose(
          TMP_POS.set(
            side.run.x * along + side.out.x * (half - PANEL_INSET),
            storey * WALL_HEIGHT,
            side.run.z * along + side.out.z * (half - PANEL_INSET),
          ),
          TMP_QUAT.setFromAxisAngle(UP, side.yaw),
          TMP_SCALE.set(1, 1, 1),
        );
        village.piece(model, MATRIX.multiplyMatrices(base, LOCAL));
      }
    }
  }

  // Pitched roof scaled onto the footprint, long axis along the longer side.
  const roof = Math.max(tilesX, tilesZ) >= 3 ? pieces.roofMedium ?? pieces.roofSmall : pieces.roofSmall;
  if (!roof) return;
  const roofLong = Math.max(tilesX, tilesZ) >= 3 ? 6 : 4;
  const longIsX = sizeX >= sizeZ;
  LOCAL.compose(
    TMP_POS.set(0, height + ROOF_SKIRT * 0.6, 0),
    TMP_QUAT.setFromAxisAngle(UP, longIsX ? Math.PI / 2 : 0),
    TMP_SCALE.set(
      Math.min(sizeX, sizeZ) / 4,
      Math.max(0.8, Math.min(sizeX, sizeZ) / 4),
      Math.max(sizeX, sizeZ) / roofLong,
    ),
  );
  village.piece(roof, MATRIX.multiplyMatrices(base, LOCAL));
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
  // wall is the kind of detail that makes a dressed set read as broken.
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

/** Wall panels sit this far inside the collider face they dress. */
const PANEL_INSET = 0.28;
/** Decks float a hair above the collider top so they never z-fight it. */
const DECK_LIFT = 0.02;
const UP = new THREE.Vector3(0, 1, 0);
const MATRIX = new THREE.Matrix4();
const LOCAL = new THREE.Matrix4();
const TMP_POS = new THREE.Vector3();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
