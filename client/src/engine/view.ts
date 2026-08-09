import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import {
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  COLOR_LIGHT_GROUND,
  COLOR_LIGHT_SKY,
  COLOR_SKY,
  COLOR_SKY_HORIZON,
  FOG_FAR,
  FOG_NEAR,
  HEMI_LIGHT_INTENSITY,
  MAX_PIXEL_RATIO,
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  RIM_LIGHT_COLOR,
  RIM_LIGHT_INTENSITY,
  RIM_LIGHT_POSITION,
  SHADOW_BIAS,
  SHADOW_CAMERA_EXTENT,
  SHADOW_CAMERA_FAR,
  SHADOW_CAMERA_NEAR,
  SHADOW_MAP_SIZE,
  SUN_COLOR,
  SUN_LIGHT_INTENSITY,
  SUN_POSITION,
  TONE_EXPOSURE,
} from '@shared/constants';

/** Renderer, scene, camera and the fixed lighting rig. */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Handoff 03 lighting rig: filmic tone mapping is what lifts the shadows
    // and rolls the highlights off — the "slight colour grade" of section 1
    // done in the tone curve rather than a LUT nobody can version-control.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_EXPOSURE;
    document.body.appendChild(this.renderer.domElement);

    // A vertical gradient rather than a flat fill. Two costs nothing extra —
    // it is a 2×64 canvas — and it gives the sky a horizon to sit against,
    // which is most of what makes distance readable in an untextured scene.
    this.scene.background = skyGradient();
    this.scene.fog = new THREE.Fog(COLOR_SKY_HORIZON, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    const hemi = new THREE.HemisphereLight(COLOR_LIGHT_SKY, COLOR_LIGHT_GROUND, HEMI_LIGHT_INTENSITY);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_LIGHT_INTENSITY);
    sun.position.set(SUN_POSITION[0], SUN_POSITION[1], SUN_POSITION[2]);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.camera.left = -SHADOW_CAMERA_EXTENT;
    sun.shadow.camera.right = SHADOW_CAMERA_EXTENT;
    sun.shadow.camera.top = SHADOW_CAMERA_EXTENT;
    sun.shadow.camera.bottom = -SHADOW_CAMERA_EXTENT;
    sun.shadow.camera.near = SHADOW_CAMERA_NEAR;
    sun.shadow.camera.far = SHADOW_CAMERA_FAR;
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Rim light: opposite the sun, cool, and casting nothing. Its whole job is
    // a bright edge on the shaded side so a runner never merges into a wall of
    // the same value. Costs one light and no shadow map.
    const rim = new THREE.DirectionalLight(RIM_LIGHT_COLOR, RIM_LIGHT_INTENSITY);
    rim.position.set(RIM_LIGHT_POSITION[0], RIM_LIGHT_POSITION[1], RIM_LIGHT_POSITION[2]);
    this.scene.add(rim);
    this.scene.add(rim.target);

    // Mild bloom (handoff 03): threshold high enough that only emissives —
    // cores, the battery halo, pad rings — and the sky bleed, never plaster.
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setSize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    this.composer.render();
  }
}

/**
 * Sky as a top-to-horizon gradient, generated at runtime.
 *
 * The asset manifest forbids shipping files for anything that can be made in
 * code, and a two-stop gradient plainly can. Drawn 2 px wide because the
 * texture varies only vertically.
 */
function skyGradient(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, `#${COLOR_SKY.toString(16).padStart(6, '0')}`);
    gradient.addColorStop(1, `#${COLOR_SKY_HORIZON.toString(16).padStart(6, '0')}`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
