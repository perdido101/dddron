import * as THREE from 'three';

/**
 * Holds the previous and current physics transforms of one body so the
 * renderer can interpolate between them with the leftover-step alpha.
 */
export class InterpolatedTransform {
  private readonly prevPosition = new THREE.Vector3();
  private readonly currPosition = new THREE.Vector3();
  private readonly prevRotation = new THREE.Quaternion();
  private readonly currRotation = new THREE.Quaternion();

  constructor(position: THREE.Vector3Like, rotation?: THREE.QuaternionLike) {
    this.teleport(position, rotation);
  }

  /** Record a new post-step transform, retiring the previous one. */
  push(position: THREE.Vector3Like, rotation?: THREE.QuaternionLike): void {
    this.prevPosition.copy(this.currPosition);
    this.prevRotation.copy(this.currRotation);
    this.currPosition.set(position.x, position.y, position.z);
    if (rotation) {
      this.currRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  }

  /** Jump both samples to the same transform, so no interpolation smears it. */
  teleport(position: THREE.Vector3Like, rotation?: THREE.QuaternionLike): void {
    this.currPosition.set(position.x, position.y, position.z);
    if (rotation) {
      this.currRotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
    this.prevPosition.copy(this.currPosition);
    this.prevRotation.copy(this.currRotation);
  }

  /** Write the interpolated transform onto an object. */
  applyTo(object: THREE.Object3D, alpha: number): void {
    object.position.lerpVectors(this.prevPosition, this.currPosition, alpha);
    object.quaternion.slerpQuaternions(this.prevRotation, this.currRotation, alpha);
  }

  /** Interpolated position only, for things that manage their own rotation. */
  readPosition(out: THREE.Vector3, alpha: number): THREE.Vector3 {
    return out.lerpVectors(this.prevPosition, this.currPosition, alpha);
  }
}
