import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

import { COLOR_DEBUG_CUBE, TEST_CUBE_SIZE, TEST_CUBE_SPAWN } from '@shared/constants';

import { InterpolatedTransform } from '../engine/interpolation';
import type { Physics } from '../engine/physics';

/**
 * Phase 0 acceptance harness: a dynamic cube that must fall, land and settle.
 * Kept in the build because it is the fastest way to eyeball whether the fixed
 * step, the interpolation and the solver are all still behaving.
 */
export class TestCube {
  private readonly mesh: THREE.Mesh;
  private readonly body: RAPIER.RigidBody;
  private readonly transform: InterpolatedTransform;

  constructor(physics: Physics, scene: THREE.Scene) {
    const [x, y, z] = TEST_CUBE_SPAWN;
    const half = TEST_CUBE_SIZE / 2;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z),
    );
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(half, half, half), this.body);

    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(TEST_CUBE_SIZE, TEST_CUBE_SIZE, TEST_CUBE_SIZE),
      new THREE.MeshLambertMaterial({ color: COLOR_DEBUG_CUBE }),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.transform = new InterpolatedTransform(this.body.translation(), this.body.rotation());
  }

  /** Call once per fixed step, after the world has stepped. */
  sample(): void {
    this.transform.push(this.body.translation(), this.body.rotation());
  }

  render(alpha: number): void {
    this.transform.applyTo(this.mesh, alpha);
  }

  drop(): void {
    const [x, y, z] = TEST_CUBE_SPAWN;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.transform.teleport(this.body.translation(), this.body.rotation());
  }

  get isAsleep(): boolean {
    return this.body.isSleeping();
  }

  get height(): number {
    return this.body.translation().y;
  }
}
