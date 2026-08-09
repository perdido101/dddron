import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The asset pipeline (handoff 03, session 7).
 *
 * Three rules, all aimed at making session 8's import a data change:
 *
 * 1. THE MANIFEST IS THE ONLY MAP from logical names to files. Code asks for
 *    'runner.character' or 'prop.throwable.1'; which GLB that is, how it is
 *    lit and what tints it is one line below. Swapping a Kenney placeholder
 *    for a Synty mesh is a manifest edit, not a refactor.
 *
 * 2. EVERY MESH GOES THROUGH THE MATERIAL OVERRIDE. Sourced packs arrive
 *    unlit, or PBR, or fond of their own palette; all of it is forced onto
 *    our one shading model (Lambert + the lighting rig) so mixed sources
 *    cannot read as mixed sources. This is the mechanism behind the
 *    handoff's "no mixed-source seams" acceptance line.
 *
 * 3. VISUALS SWAP NON-DESTRUCTIVELY. Nothing in here touches a collider or
 *    any gameplay object; loaders hand back Object3Ds and the gameplay side
 *    parents them under existing bodies. A failed load returns null and the
 *    caller keeps its primitive — a missing decoration must never be able to
 *    stop the thing it decorates.
 */
export interface AssetEntry {
  /** Path under /models/. */
  readonly file: string;
  /**
   * Force onto our palette and shading model. Defaults to true; opt out only
   * for something that must keep its own material (nothing does today).
   */
  readonly relight?: boolean;
  /** Multiply colour, e.g. to pull a pack's albedo toward our palette. */
  readonly tint?: number;
  /** Emissive override, for gameplay-critical glow. */
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  /**
   * Optional lower-detail stand-ins: [file, distance] pairs, nearest first.
   * When present, loadAsset returns a THREE.LOD instead of a plain scene.
   */
  readonly lod?: readonly (readonly [string, number])[];
}

/**
 * Logical name -> file. THE single place an art swap happens.
 *
 * Texture atlasing note: each Kenney kit shares one colormap by construction
 * (blocky = 1 texture, survival = 1, town = 1), so every entry from the same
 * kit batches into the same texture unit. A future pack should keep that
 * property — one atlas per kit — and then this table needs no new concept.
 */
export const ASSET_MANIFEST: Record<string, AssetEntry> = {
  'runner.character': { file: 'kenney-blocky/character.glb' },

  'prop.throwable.0': { file: 'quaternius-village/Prop_Crate.gltf' },
  'prop.throwable.1': { file: 'quaternius-village/Prop_Brick2.gltf' },
  'prop.throwable.2': { file: 'quaternius-nature/Rock_Medium_2.gltf' },
  'prop.throwable.3': { file: 'quaternius-nature/Pebble_Square_6.gltf' },

  // Session 8: the environment is the Quaternius family (Medieval Village
  // MegaKit + Stylized Nature MegaKit, both CC0) — one source, per handoff 03
  // section 6. The character stays on its locked rig above.
  'village.wallPlaster': { file: 'quaternius-village/Wall_Plaster_Straight.gltf' },
  'village.wallPlasterDoor': { file: 'quaternius-village/Wall_Plaster_Door_Flat.gltf' },
  'village.wallPlasterWindow': { file: 'quaternius-village/Wall_Plaster_Window_Wide_Flat.gltf' },
  'village.wallBrick': { file: 'quaternius-village/Wall_UnevenBrick_Straight.gltf' },
  'village.wallBrickDoor': { file: 'quaternius-village/Wall_UnevenBrick_Door_Flat.gltf' },
  'village.wallBrickWindow': { file: 'quaternius-village/Wall_UnevenBrick_Window_Wide_Flat.gltf' },
  'village.roofSmall': { file: 'quaternius-village/Roof_RoundTiles_4x4.gltf' },
  'village.roofMedium': { file: 'quaternius-village/Roof_RoundTiles_4x6.gltf' },
  'village.roofLarge': { file: 'quaternius-village/Roof_RoundTiles_6x8.gltf' },
  'village.roofTower': { file: 'quaternius-village/Roof_Tower_RoundTiles.gltf' },
  'village.roofPlank': { file: 'quaternius-village/Roof_Wooden_2x1.gltf' },
  'village.floorWood': { file: 'quaternius-village/Floor_WoodDark.gltf' },
  'village.stairs': { file: 'quaternius-village/Stairs_Exterior_Straight.gltf' },
  'village.crate': { file: 'quaternius-village/Prop_Crate.gltf' },
  'village.wagon': { file: 'quaternius-village/Prop_Wagon.gltf' },
  'village.chimney': { file: 'quaternius-village/Prop_Chimney.gltf' },
  'village.fence': { file: 'quaternius-village/Prop_WoodenFence_Single.gltf' },
  'village.fenceLong': { file: 'quaternius-village/Prop_WoodenFence_Extension1.gltf' },
  'village.border': { file: 'quaternius-village/Prop_ExteriorBorder_Straight1.gltf' },

  'village.tree1': { file: 'quaternius-nature/CommonTree_1.gltf' },
  'village.tree2': { file: 'quaternius-nature/CommonTree_2.gltf' },
  'village.tree3': { file: 'quaternius-nature/CommonTree_3.gltf' },
  'village.pine1': { file: 'quaternius-nature/Pine_1.gltf' },
  'village.pine2': { file: 'quaternius-nature/Pine_2.gltf' },
  'village.treeLandmark': { file: 'quaternius-nature/TwistedTree_1.gltf' },
  // Both bush entries use the flowering variant: the kit's plain bush GLTF
  // mis-references the twisted tree's RED leaf sheet (engine versions retint
  // it), and a hedgerow of green-with-flowers beats a hedgerow of maroon.
  'village.bush': { file: 'quaternius-nature/Bush_Common_Flowers.gltf' },
  'village.bushFlowers': { file: 'quaternius-nature/Bush_Common_Flowers.gltf' },
  'village.grassShort': { file: 'quaternius-nature/Grass_Common_Short.gltf' },
  'village.grassTall': { file: 'quaternius-nature/Grass_Common_Tall.gltf' },
  'village.grassWispy': { file: 'quaternius-nature/Grass_Wispy_Tall.gltf' },
  'village.flowerPink': { file: 'quaternius-nature/Flower_3_Group.gltf' },
  'village.flowerTall': { file: 'quaternius-nature/Flower_4_Group.gltf' },
  'village.clover': { file: 'quaternius-nature/Clover_1.gltf' },
  'village.rock': { file: 'quaternius-nature/Rock_Medium_1.gltf' },
  'village.pebble': { file: 'quaternius-nature/Pebble_Round_2.gltf' },
};

export interface LoadedAsset {
  /** Null when the fetch failed — keep the primitive. */
  scene: THREE.Object3D | null;
  animations: THREE.AnimationClip[];
}

/**
 * Shared loader with Draco support.
 *
 * The decoder is self-hosted under /draco for the same reason the font is:
 * a blocked CDN must not be able to take the meshes with it. Draco costs
 * nothing when a GLB is uncompressed, so it is simply always wired.
 */
let sharedLoader: GLTFLoader | null = null;

function loader(): GLTFLoader {
  if (sharedLoader) return sharedLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath(new URL('draco/', document.baseURI).href);
  sharedLoader = new GLTFLoader();
  sharedLoader.setDRACOLoader(draco);
  return sharedLoader;
}

/** One fetch per file per session, however many callers ask. */
const cache = new Map<string, Promise<LoadedAsset>>();

/**
 * Load by logical name. Resolves — never rejects — with nulls on failure.
 */
export function loadAsset(name: string): Promise<LoadedAsset> {
  const entry = ASSET_MANIFEST[name];
  if (!entry) {
    console.warn(`BUZZKILL: no manifest entry for asset "${name}"`);
    return Promise.resolve({ scene: null, animations: [] });
  }

  let pending = cache.get(name);
  if (!pending) {
    pending = fetchEntry(name, entry);
    cache.set(name, pending);
  }
  // Clone per caller: two throwables sharing one cached box must not share
  // one Object3D. Materials are shared deliberately — same look, one program.
  return pending.then(({ scene, animations }) => ({
    scene: scene ? scene.clone(true) : null,
    animations,
  }));
}

async function fetchEntry(name: string, entry: AssetEntry): Promise<LoadedAsset> {
  try {
    const url = new URL(`models/${entry.file}`, document.baseURI).href;
    const gltf = await loader().loadAsync(url);
    if (entry.relight !== false) overrideMaterials(gltf.scene, entry);

    if (entry.lod && entry.lod.length > 0) {
      const lod = new THREE.LOD();
      lod.addLevel(gltf.scene, 0);
      for (const [file, distance] of entry.lod) {
        const low = await loader().loadAsync(new URL(`models/${file}`, document.baseURI).href);
        if (entry.relight !== false) overrideMaterials(low.scene, entry);
        lod.addLevel(low.scene, distance);
      }
      return { scene: lod, animations: gltf.animations };
    }
    return { scene: gltf.scene, animations: gltf.animations };
  } catch (cause) {
    console.warn(`BUZZKILL: asset "${name}" (${entry.file}) unavailable —`, cause);
    return { scene: null, animations: [] };
  }
}

/**
 * The override: whatever a pack shipped — unlit, PBR, vertex-coloured — it
 * leaves here as Lambert under our lighting rig, tinted onto our palette.
 */
function overrideMaterials(root: THREE.Object3D, entry: AssetEntry): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const source = node.material as THREE.MeshStandardMaterial;
    const material = new THREE.MeshLambertMaterial({
      map: source.map ?? null,
      color: source.color ? source.color.clone() : new THREE.Color(0xffffff),
      // Trust the material's own declaration, not the attribute's presence:
      // some kits park non-colour data in COLOR_0, and multiplying it in
      // turns green canopies maroon.
      vertexColors: source.vertexColors === true,
      // Foliage cards live or die on these: leaves ship as alpha-cutout
      // planes, and flattening them to opaque single-sided Lambert turns
      // every tree into a black blob.
      side: source.side ?? THREE.FrontSide,
      alphaTest: source.alphaTest > 0 ? source.alphaTest : source.transparent ? 0.5 : 0,
    });
    if (entry.tint !== undefined) material.color.multiply(new THREE.Color(entry.tint));
    if (entry.emissive !== undefined) {
      material.emissive.setHex(entry.emissive);
      material.emissiveIntensity = entry.emissiveIntensity ?? 1;
    }
    node.material = material;
    node.castShadow = true;
    node.receiveShadow = true;
  });
}

/**
 * Rim light as a material feature, not just a scene light (session 7 item 8).
 *
 * A fresnel term added at compile time: faces turning away from the camera
 * pick up a cool edge, which is what keeps a dynamic object's silhouette
 * readable against a same-value background at range. Applied to characters
 * and the drone — the things a player must find at 40 m — and not to the
 * scenery they must be found against.
 */
export function addRimLight(
  material: THREE.Material,
  colour = RIM_COLOUR,
  strength = RIM_STRENGTH,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimColour = { value: new THREE.Color(colour) };
    shader.uniforms.rimStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        'uniform vec3 rimColour;\nuniform float rimStrength;\nvoid main() {',
      )
      .replace(
        '#include <opaque_fragment>',
        `float rim = 1.0 - abs(dot(normalize(vViewPosition), normal));
        rim = pow(rim, 2.5) * rimStrength;
        outgoingLight += rimColour * rim;
        #include <opaque_fragment>`,
      );
  };
  material.needsUpdate = true;
}

const RIM_COLOUR = 0xcfe8ff;
const RIM_STRENGTH = 0.55;
