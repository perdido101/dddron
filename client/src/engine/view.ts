import * as THREE from 'three';

import {
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  COLOR_LIGHT_GROUND,
  COLOR_LIGHT_SKY,
  COLOR_SKY,
  FOG_FAR,
  FOG_NEAR,
  HEMI_LIGHT_INTENSITY,
  MAX_PIXEL_RATIO,
  SHADOW_BIAS,
  SHADOW_CAMERA_EXTENT,
  SHADOW_CAMERA_FAR,
  SHADOW_CAMERA_NEAR,
  SHADOW_MAP_SIZE,
  SUN_LIGHT_INTENSITY,
  SUN_POSITION,
} from '@shared/constants';

/** Renderer, scene, camera and the fixed lighting rig. */
export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(COLOR_SKY);
    this.scene.fog = new THREE.Fog(COLOR_SKY, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    const hemi = new THREE.HemisphereLight(COLOR_LIGHT_SKY, COLOR_LIGHT_GROUND, HEMI_LIGHT_INTENSITY);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, SUN_LIGHT_INTENSITY);
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

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
