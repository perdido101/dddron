import * as THREE from 'three';

import type { Vec3 } from '@shared/fuse';

import {
  CONFETTI_COLORS,
  CONFETTI_COUNT,
  CONFETTI_GRAVITY,
  CONFETTI_LIFETIME,
  CONFETTI_SIZE,
  CONFETTI_SPEED,
} from '@shared/constants';

/**
 * Detonation burst.
 *
 * Deliberately confetti and not gore: the brief wants detonation to read as
 * celebratory, because being blown up is the funny part of the round, not a
 * punishment. Pure particles, no physics bodies — this never touches the solver.
 */
export class Confetti {
  private readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly material: THREE.PointsMaterial;
  private age = CONFETTI_LIFETIME;

  constructor(scene: THREE.Scene) {
    this.positions = new Float32Array(CONFETTI_COUNT * 3);
    this.velocities = new Float32Array(CONFETTI_COUNT * 3);

    const colors = new Float32Array(CONFETTI_COUNT * 3);
    const colour = new THREE.Color();
    for (let i = 0; i < CONFETTI_COUNT; i += 1) {
      const hex = CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? CONFETTI_COLORS[0];
      colour.setHex(hex);
      colors[i * 3] = colour.r;
      colors[i * 3 + 1] = colour.g;
      colors[i * 3 + 2] = colour.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.material = new THREE.PointsMaterial({
      size: CONFETTI_SIZE,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  /** Fire a burst from a point. Re-firing restarts the existing particles. */
  burst(origin: Vec3): void {
    for (let i = 0; i < CONFETTI_COUNT; i += 1) {
      // Even-ish sphere of directions, biased upward so it reads as a popper.
      const theta = (i / CONFETTI_COUNT) * Math.PI * 2 * GOLDEN_ANGLE_TURNS;
      const y = 1 - (i / (CONFETTI_COUNT - 1)) * 1.4;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      const speed = CONFETTI_SPEED * (0.45 + ((i * 7) % 11) / 11);

      this.positions[i * 3] = origin.x;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z;
      this.velocities[i * 3] = Math.cos(theta) * radius * speed;
      this.velocities[i * 3 + 1] = Math.abs(y) * speed + speed * 0.35;
      this.velocities[i * 3 + 2] = Math.sin(theta) * radius * speed;
    }
    this.age = 0;
    this.points.visible = true;
  }

  update(frameDelta: number): void {
    if (this.age >= CONFETTI_LIFETIME) return;
    this.age += frameDelta;

    for (let i = 0; i < CONFETTI_COUNT * 3; i += 3) {
      const vy = (this.velocities[i + 1] ?? 0) + CONFETTI_GRAVITY * frameDelta;
      this.velocities[i + 1] = vy;
      this.positions[i] = (this.positions[i] ?? 0) + (this.velocities[i] ?? 0) * frameDelta;
      this.positions[i + 1] = (this.positions[i + 1] ?? 0) + vy * frameDelta;
      this.positions[i + 2] = (this.positions[i + 2] ?? 0) + (this.velocities[i + 2] ?? 0) * frameDelta;
    }

    this.material.opacity = 1 - this.age / CONFETTI_LIFETIME;
    this.points.geometry.attributes.position!.needsUpdate = true;
    if (this.age >= CONFETTI_LIFETIME) this.points.visible = false;
  }
}

/** Spreads successive particles around the sphere instead of banding them. */
const GOLDEN_ANGLE_TURNS = 0.381966;
