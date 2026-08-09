import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { CAPSULE_HEIGHT, RUN_SPEED } from '@shared/constants';

/** What the character needs in order to pick a clip. */
export interface CharacterState {
  /** Horizontal speed in m/s. */
  readonly speed: number;
  readonly grounded: boolean;
  readonly carrying: boolean;
  readonly alive: boolean;
  /** Mid-interact hold: picking a core up, inserting, or sabotaging a pad. */
  readonly interacting: boolean;
}

/**
 * The runner's body: Kenney "Blocky Characters" (CC0), animated.
 *
 * This replaces both the capsule-and-sphere stand-in AND the Mixamo route the
 * manifest planned for. The pack ships 27 baked clips in the GLB — idle, walk,
 * sprint, die, pick-up, holding-both, attack-melee — which covers every P0 and
 * P1 animation on the manifest without an Adobe account or a retarget. One
 * mesh, one texture, 134 kB, public domain.
 *
 * Loading is deliberately optional: if the GLB fails for any reason the caller
 * keeps its primitive body and the game plays exactly as before. A missing
 * decoration must never be a missing game.
 */
export class Character {
  readonly object = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  /** Set while a one-shot (swat, pick-up) is playing and must not be cut. */
  private lockUntil = 0;
  private clock = 0;
  private readonly tint = new THREE.Color(0xffffff);
  private materials: THREE.MeshLambertMaterial[] = [];

  get loaded(): boolean {
    return this.mixer !== null;
  }

  /**
   * Build the body from an already-parsed template.
   *
   * @param template the shared, loaded GLTF scene. Cloned per character.
   * @param animations the shared clips, rebound to this clone by node name.
   */
  constructor(template: THREE.Object3D | null, animations: readonly THREE.AnimationClip[]) {
    if (!template) return;

    const body = template.clone(true);

    // Kenney ships these unlit, which is correct for a flat mobile look and
    // wrong here: an unlit body ignores the sun, the rim light and the fog, so
    // it floats free of the arena instead of standing in it. Rebuilt as
    // Lambert against the same texture so it takes the same light as the walls.
    this.materials = [];
    body.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const source = node.material as THREE.MeshStandardMaterial;
      const material = new THREE.MeshLambertMaterial({
        map: source.map ?? null,
        color: 0xffffff,
      });
      node.material = material;
      node.castShadow = true;
      this.materials.push(material);
    });

    // Scale to the collider rather than trusting the asset's units. Measured
    // from the assembled bounds, so swapping in a different character — or a
    // differently-scaled export of this one — needs no constant changed.
    const bounds = new THREE.Box3().setFromObject(body);
    const height = bounds.max.y - bounds.min.y;
    if (height > 1e-3) {
      const scale = CAPSULE_HEIGHT / height;
      body.scale.setScalar(scale);
      // Stand it on the group's origin: the runner's rig hangs from the feet.
      body.position.y = -bounds.min.y * scale;
    }

    this.object.add(body);
    this.mixer = new THREE.AnimationMixer(body);
    for (const clip of animations) {
      this.clips.set(clip.name, this.mixer.clipAction(clip));
    }
    this.play('idle');
  }

  /** Tint the whole body by colourway. Multiplies the texture. */
  setColorway(colour: number): void {
    this.tint.setHex(colour);
    for (const material of this.materials) material.color.copy(this.tint);
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  /** Pick and advance the clip. Cosmetic, so it runs on the render delta. */
  update(frameDelta: number, state: CharacterState): void {
    const mixer = this.mixer;
    if (!mixer) return;
    this.clock += frameDelta;

    if (this.clock >= this.lockUntil) this.play(this.clipFor(state));
    mixer.update(frameDelta);
  }

  private clipFor(state: CharacterState): string {
    if (!state.alive) return 'die';
    // Carrying reads first: both hands are full, whatever the legs are doing.
    if (state.carrying) return 'holding-both';
    if (state.interacting && state.grounded && state.speed < WALK_SPEED_RATIO * RUN_SPEED) {
      return 'pick-up';
    }
    // No jump clip in the pack; sprint keeps the legs moving, which reads
    // better airborne than a frozen idle.
    if (!state.grounded) return 'sprint';
    const ratio = state.speed / RUN_SPEED;
    if (ratio > SPRINT_SPEED_RATIO) return 'sprint';
    if (ratio > WALK_SPEED_RATIO) return 'walk';
    return 'idle';
  }

  /** Play a one-shot that the state machine may not interrupt. */
  playOnce(name: string, seconds: number): void {
    if (!this.clips.has(name)) return;
    this.play(name);
    this.lockUntil = this.clock + seconds;
  }

  private play(name: string): void {
    if (name === this.currentName) return;
    const next = this.clips.get(name);
    if (!next) return;

    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (this.current) {
      // Crossfade rather than cut: at 60 fps a hard swap between walk and
      // sprint is a visible glitch on every acceleration.
      this.current.crossFadeTo(next, CROSSFADE, false);
      next.play();
    } else {
      next.play();
    }
    this.current = next;
    this.currentName = name;
  }

  reset(): void {
    this.lockUntil = 0;
    this.currentName = '';
    this.current = null;
    this.play('idle');
  }
}

/**
 * Load the character once for the whole session.
 *
 * Resolves to nulls rather than rejecting: the game must start even if the
 * asset does not, and every caller already has a primitive fallback.
 */
export async function loadCharacter(): Promise<{
  scene: THREE.Object3D | null;
  animations: THREE.AnimationClip[];
}> {
  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(CHARACTER_URL);
    return { scene: gltf.scene, animations: gltf.animations };
  } catch (cause) {
    console.warn('BUZZKILL: character model unavailable, using primitives —', cause);
    return { scene: null, animations: [] };
  }
}

/**
 * Throwable props: Kenney "Survival Kit" (CC0), the manifest's crate / bucket
 * / ball line item. Loaded together and handed to Hazards; a failure leaves
 * the spheres in place, which are perfectly playable.
 */
export async function loadProps(): Promise<THREE.Object3D[]> {
  const loader = new GLTFLoader();
  const loaded = await Promise.all(
    PROP_FILES.map(async (name) => {
      try {
        const gltf = await loader.loadAsync(
          new URL(`models/kenney-survival/${name}.glb`, document.baseURI).href,
        );
        // Kenney ships these unlit too; relight them for the same reason the
        // character is relit.
        gltf.scene.traverse((node) => {
          if (!(node instanceof THREE.Mesh)) return;
          const source = node.material as THREE.MeshStandardMaterial;
          node.material = new THREE.MeshLambertMaterial({ map: source.map ?? null });
          node.castShadow = true;
        });
        return gltf.scene as THREE.Object3D;
      } catch (cause) {
        console.warn(`BUZZKILL: prop "${name}" unavailable —`, cause);
        return null;
      }
    }),
  );
  return loaded.filter((scene): scene is THREE.Object3D => scene !== null);
}

const PROP_FILES = ['box', 'bucket', 'barrel', 'rock-a'] as const;

/**
 * Relative so the same bundle works at a domain root and under the GitHub
 * Pages project subpath, matching vite's `base: './'`.
 */
const CHARACTER_URL = new URL('models/kenney-blocky/character.glb', document.baseURI).href;
/** Seconds of blend between clips. */
const CROSSFADE = 0.18;
/** Speed ratios at which the clip changes. */
const WALK_SPEED_RATIO = 0.08;
const SPRINT_SPEED_RATIO = 0.55;
