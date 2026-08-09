import * as THREE from 'three';

import {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  COLOR_CORE,
  COLOR_PROP,
  COLOR_RUNNER,
  COLOR_RUNNER_HEAD,
  CORE_RADIUS,
  DRONE_RADIUS,
  HEAD_OFFSET,
  HEAD_RADIUS,
  NET_INTERPOLATION_LAG,
} from '@shared/constants';

import type { NetSnapshot } from './connection';

interface Avatar {
  group: THREE.Group;
  target: THREE.Vector3;
  targetYaw: number;
}

/**
 * Draws everyone who is not us, plus the server's cores.
 *
 * Remote entities are interpolated toward the last snapshot rather than snapped
 * to it: the server broadcasts at 20 Hz and we render at 60+, so without this
 * every other player moves in visible steps. The local player is never touched
 * here — sacred constraint 5 means our own body is ours alone.
 */
export class RemoteAvatars {
  /**
   * Where the relayed drone is right now.
   *
   * Runners need this: a swat, a thrown prop and a ceiling fan are all range
   * checks against the drone, and online the only drone that exists for them
   * is this avatar. Without it every hazard measures against a stowed local
   * copy sitting at the spawn point and silently never connects.
   */
  readonly dronePosition = new THREE.Vector3();
  /** False when nobody in the room is flying, so the position is stale. */
  droneTracked = false;

  private readonly avatars = new Map<string, Avatar>();
  private readonly coreMeshes: THREE.Mesh[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** @param selfId our own session id, which must not be drawn twice. */
  update(snapshot: NetSnapshot, selfId: string, frameDelta: number): void {
    const seen = new Set<string>();
    let droneId = '';

    for (const player of snapshot.players) {
      if (player.role === 'drone') droneId = player.sessionId;
      if (player.sessionId === selfId) continue;
      seen.add(player.sessionId);

      let avatar = this.avatars.get(player.sessionId);
      if (!avatar) {
        avatar = this.createAvatar(player.role);
        this.avatars.set(player.sessionId, avatar);
      }
      avatar.target.set(player.x, player.y, player.z);
      avatar.targetYaw = player.yaw;
      avatar.group.visible = player.alive || player.role === 'drone';
    }

    // Drop anyone who left.
    for (const [id, avatar] of this.avatars) {
      if (seen.has(id)) continue;
      this.scene.remove(avatar.group);
      this.avatars.delete(id);
    }

    const blend = 1 - Math.exp(-frameDelta / NET_INTERPOLATION_LAG);
    for (const avatar of this.avatars.values()) {
      avatar.group.position.lerp(avatar.target, blend);
      avatar.group.rotation.y += shortestAngle(avatar.group.rotation.y, avatar.targetYaw) * blend;
    }

    // Read the interpolated position, not the raw snapshot: hazards should
    // measure against the drone the player can actually see.
    const flier = droneId && droneId !== selfId ? this.avatars.get(droneId) : undefined;
    this.droneTracked = flier !== undefined;
    if (flier) this.dronePosition.copy(flier.group.position);

    this.syncCores(snapshot);
  }

  private createAvatar(role: string): Avatar {
    const group = new THREE.Group();

    if (role === 'drone') {
      const hull = new THREE.Mesh(
        new THREE.CylinderGeometry(DRONE_RADIUS, DRONE_RADIUS * 0.82, DRONE_RADIUS * 0.55, 16),
        new THREE.MeshLambertMaterial({ color: COLOR_PROP }),
      );
      hull.castShadow = true;
      group.add(hull);
    } else {
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2),
        new THREE.MeshLambertMaterial({ color: COLOR_RUNNER }),
      );
      body.castShadow = true;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_RADIUS),
        new THREE.MeshLambertMaterial({ color: COLOR_RUNNER_HEAD }),
      );
      head.position.y = HEAD_OFFSET;
      head.castShadow = true;
      group.add(body, head);
    }

    this.scene.add(group);
    return { group, target: new THREE.Vector3(), targetYaw: 0 };
  }

  /** Server-owned cores. Local core visuals are disabled while connected. */
  private syncCores(snapshot: NetSnapshot): void {
    while (this.coreMeshes.length < snapshot.cores.length) {
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(CORE_RADIUS, CORE_RADIUS * 1.1),
        new THREE.MeshLambertMaterial({ color: COLOR_CORE, emissive: COLOR_CORE, emissiveIntensity: 0.35 }),
      );
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.coreMeshes.push(mesh);
    }

    for (let i = 0; i < this.coreMeshes.length; i += 1) {
      const mesh = this.coreMeshes[i];
      const core = snapshot.cores[i];
      if (!mesh) continue;
      if (!core || core.state === 'inserted') {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(core.x, core.y, core.z);
    }
  }

  /** Dev-only census, so a test can assert what is actually on screen. */
  census(): { avatars: number; cores: number; corePositions: number[][] } {
    const corePositions = this.coreMeshes
      .filter((mesh) => mesh.visible)
      .map((mesh) => [mesh.position.x, mesh.position.y, mesh.position.z]);
    return { avatars: this.avatars.size, cores: corePositions.length, corePositions };
  }

  /** Remove everything, e.g. when the connection drops. */
  clear(): void {
    for (const avatar of this.avatars.values()) this.scene.remove(avatar.group);
    this.avatars.clear();
    this.droneTracked = false;
    for (const mesh of this.coreMeshes) mesh.visible = false;
  }
}

function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
