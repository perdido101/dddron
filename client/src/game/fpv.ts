import * as THREE from 'three';

import {
  CAMERA_FAR,
  CAMERA_NEAR,
  DRONE_MAX_SPEED,
  FPV_BARREL_DISTORTION,
  FPV_BLOOM_BOOST,
  FPV_CAMERA_OFFSET,
  FPV_CHROMATIC_ABERRATION,
  FPV_FOV,
  FPV_ROLLING_SHUTTER,
  FPV_SCANLINE_DENSITY,
  FPV_SCANLINE_OPACITY,
  FPV_SENSOR_NOISE,
  FPV_SHADOW_TINT,
  FPV_SHAKE_RPM_MULT,
  FPV_SHAKE_VELOCITY_MULT,
  FPV_TELEGRAPH_EFFECT_MULT,
  FPV_TRANSITION_MS,
  FPV_VIGNETTE,
} from '@shared/constants';

/**
 * The drone's onboard camera feed.
 *
 * The camera is hard-parented to the drone body — no gimbal, no stabilisation,
 * no smoothing. Every tilt, bounce and wall bonk comes through, because a
 * stabilised feed would look like a game camera rather than a cheap plastic
 * toy's video downlink.
 *
 * The scene is rendered to a target and then blitted through a fragment shader
 * that does the whole feed treatment in one pass: barrel distortion, chromatic
 * aberration, rolling-shutter skew, scanlines, vignette, grain and a cyan
 * shadow lift. One pass keeps it cheap enough to be free on the frame budget.
 */
export class FpvFeed {
  readonly camera: THREE.PerspectiveCamera;

  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly mount = new THREE.Group();
  private readonly shake = new THREE.Vector3();

  private clock = 0;
  /** 0 = fully third-person, 1 = fully in the feed. Drives the switch dressing. */
  private transition = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(FPV_FOV, 1, CAMERA_NEAR, CAMERA_FAR);

    const size = new THREE.Vector2();
    renderer.getSize(size);
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tFeed: { value: this.target.texture },
        uTime: { value: 0 },
        uBarrel: { value: FPV_BARREL_DISTORTION },
        uAberration: { value: FPV_CHROMATIC_ABERRATION },
        uScanline: { value: FPV_SCANLINE_OPACITY },
        uScanDensity: { value: FPV_SCANLINE_DENSITY },
        uVignette: { value: FPV_VIGNETTE },
        uNoise: { value: FPV_SENSOR_NOISE },
        uSkew: { value: 0 },
        uBloom: { value: FPV_BLOOM_BOOST },
        uTint: { value: new THREE.Vector3(...FPV_SHADOW_TINT) },
        uTransition: { value: 1 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    // The vertex shader writes clip space directly and ignores the camera, but
    // three still frustum-culls by bounding sphere — and a 2x2 plane sitting on
    // the ortho near plane culls out, so the pass silently draws nothing.
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    // Mount point is a child transform on the drone body, so it inherits the
    // body's full orientation for free.
    this.camera.position.set(0, 0, 0);
    this.mount.position.set(FPV_CAMERA_OFFSET[0], FPV_CAMERA_OFFSET[1], -FPV_CAMERA_OFFSET[2]);
    this.mount.add(this.camera);
  }

  /** Attach the rig to the drone's tilting chassis, not to its yaw-only root. */
  attachTo(chassis: THREE.Object3D): void {
    chassis.add(this.mount);
  }

  resize(width: number, height: number): void {
    this.target.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param velocity drone velocity, for vibration and rolling-shutter skew.
   * @param yawRate radians/second of turn, which is what skews a cheap sensor.
   * @param throttle 0-1 rotor RPM.
   * @param telegraph 0-1, doubles noise and skew over the final seconds.
   * @param active whether the feed is the mode being shown.
   */
  update(
    frameDelta: number,
    velocity: THREE.Vector3,
    yawRate: number,
    throttle: number,
    telegraph: number,
    active: boolean,
  ): void {
    this.clock += frameDelta;

    const towards = active ? 1 : 0;
    const rate = frameDelta / (FPV_TRANSITION_MS / 1000);
    this.transition += THREE.MathUtils.clamp(towards - this.transition, -rate, rate);

    // Vibration: it is bolted to a buzzing plastic object, so it never sits
    // perfectly still. Both terms are NORMALISED to 0-1 first, so the multipliers
    // are amplitudes in radians. Feeding in raw m/s and raw RPM instead made the
    // constants read as ~35 degrees of sway, which is nausea, not vibration.
    const jitter =
      Math.min(velocity.length() / DRONE_MAX_SPEED, 1) * FPV_SHAKE_VELOCITY_MULT
      + Math.min(throttle, 1) * FPV_SHAKE_RPM_MULT;
    this.shake.set(
      Math.sin(this.clock * 91.3) * jitter,
      Math.sin(this.clock * 77.7) * jitter,
      0,
    );
    this.mount.position.set(
      FPV_CAMERA_OFFSET[0] + this.shake.x * SHAKE_TRANSLATION,
      FPV_CAMERA_OFFSET[1] + this.shake.y * SHAKE_TRANSLATION,
      -FPV_CAMERA_OFFSET[2],
    );
    this.camera.rotation.set(this.shake.y, 0, this.shake.x);

    const boost = 1 + telegraph * (FPV_TELEGRAPH_EFFECT_MULT - 1);
    this.material.uniforms.uTime!.value = this.clock;
    this.material.uniforms.uNoise!.value = FPV_SENSOR_NOISE * boost;
    this.material.uniforms.uSkew!.value = THREE.MathUtils.clamp(
      yawRate * FPV_ROLLING_SHUTTER * boost,
      -MAX_SKEW,
      MAX_SKEW,
    );
    this.material.uniforms.uTransition!.value = this.transition;
  }

  /** True once the feed has fully taken over, or is still collapsing away. */
  get visible(): boolean {
    return this.transition > 0.001;
  }

  /** Render the scene through the onboard camera and blit it treated. */
  render(scene: THREE.Scene): void {
    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, this.camera);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}

/** How far the vibration is allowed to physically move the camera, in metres. */
const SHAKE_TRANSLATION = 0.02;
/** Cap on rolling-shutter skew so a fast spin cannot tear the frame apart. */
const MAX_SKEW = 0.08;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tFeed;
  uniform float uTime;
  uniform float uBarrel;
  uniform float uAberration;
  uniform float uScanline;
  uniform float uScanDensity;
  uniform float uVignette;
  uniform float uNoise;
  uniform float uSkew;
  uniform float uBloom;
  uniform vec3 uTint;
  uniform float uTransition;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = vUv;

    // Rolling shutter: each scanline is sampled at a slightly different moment,
    // so a fast turn skews the frame. This is what sells "cheap camera".
    uv.x += uSkew * (uv.y - 0.5);

    // Barrel distortion, strongest at the edges. Normalised by the distortion
    // at the frame corner so the corners still map to the corners — without
    // that the lens samples off the edge of the target and leaves black wedges
    // in the picture rather than a fisheye.
    vec2 centred = uv - 0.5;
    float r2 = dot(centred, centred);
    float k = 1.0 + uBarrel * r2;
    float kCorner = 1.0 + uBarrel * 0.5;
    vec2 distorted = centred * (k / kCorner);

    // Chromatic aberration scales toward the edges, as a real lens does.
    float edge = length(distorted);
    vec2 shift = distorted * uAberration * edge;
    vec2 uvR = distorted + shift + 0.5;
    vec2 uvG = distorted + 0.5;
    vec2 uvB = distorted - shift + 0.5;

    vec3 colour = vec3(
      texture2D(tFeed, uvR).r,
      texture2D(tFeed, uvG).g,
      texture2D(tFeed, uvB).b
    );

    // Outside the distorted frame there is no signal.
    vec2 clamped = clamp(uvG, 0.0, 1.0);
    if (clamped != uvG) colour = vec3(0.02, 0.03, 0.04);

    colour *= uBloom;
    // Cyan lift in the shadows only, so highlights stay clean.
    colour += uTint * (1.0 - smoothstep(0.0, 0.6, dot(colour, vec3(0.299, 0.587, 0.114))));

    float scan = 1.0 - uScanline * (0.5 + 0.5 * sin(uv.y * uScanDensity));
    colour *= scan;

    colour += (hash(uv * 1024.0 + uTime * 60.0) - 0.5) * uNoise;

    float vig = smoothstep(0.85, 0.25, length(centred));
    colour *= mix(1.0, vig, uVignette);

    // Feed-switch dressing: the picture collapses to a horizontal band and
    // bursts with static rather than dollying through the world.
    float band = smoothstep(0.0, 0.5, uTransition);
    float open = abs(uv.y - 0.5) < (0.5 * band) ? 1.0 : 0.0;
    float static_ = hash(uv * 512.0 + uTime * 120.0);
    colour = mix(vec3(static_) * 0.6, colour, smoothstep(0.35, 1.0, uTransition));
    colour *= open;

    gl_FragColor = vec4(colour, 1.0);
  }
`;
