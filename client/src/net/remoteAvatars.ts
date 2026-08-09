import * as THREE from 'three';

import {
  CAPSULE_HALF_HEIGHT,
  CAPSULE_RADIUS,
  COLOR_CORE,
  COLOR_CORE_CARRIED,
  COLOR_PROP,
  CORE_SHAFT_HEIGHT,
  CORE_SHAFT_OPACITY,
  CORE_SHAFT_RADIUS,
  CORE_SHAFT_SPIN,
  FOOT_OFFSET,
  COLOR_RUNNER,
  COLOR_RUNNER_HEAD,
  CORE_RADIUS,
  DRONE_RADIUS,
  HEAD_OFFSET,
  HEAD_RADIUS,
  NET_INTERPOLATION_LAG,
  RUNNER_COLORWAYS,
} from '@shared/constants';

import { Character } from '../game/character';
import type { NetSnapshot } from './connection';

interface Avatar {
  group: THREE.Group;
  target: THREE.Vector3;
  targetYaw: number;
  /** The animated body, when the model loaded. Drones get none. */
  character: Character | null;
  /** Previous position, so speed can drive the clip without a velocity feed. */
  readonly previous: THREE.Vector3;
  speed: number;
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

  private template: THREE.Object3D | null = null;
  private animations: THREE.AnimationClip[] = [];
  private readonly avatars = new Map<string, Avatar>();
  private readonly coreMeshes: THREE.Mesh[] = [];
  /** One light shaft per core, shown only while that core is carried. */
  private readonly coreShafts: THREE.Mesh[] = [];
  private shaftClock = 0;

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
        avatar = this.createAvatar(player.role, player.colorway);
        this.avatars.set(player.sessionId, avatar);
      }
      avatar.target.set(player.x, player.y, player.z);
      avatar.targetYaw = player.yaw;
      avatar.group.visible = player.alive || player.role === 'drone';

      if (avatar.character) {
        // Speed comes from how far the avatar actually moved on screen, not
        // from the snapshot: the interpolation below is what the eye sees, so
        // that is what the walk-versus-sprint choice has to agree with.
        const moved = avatar.group.position.distanceTo(avatar.previous);
        avatar.speed = frameDelta > 0 ? moved / frameDelta : 0;
        avatar.previous.copy(avatar.group.position);
        avatar.character.update(frameDelta, {
          speed: avatar.speed,
          grounded: true,
          carrying: player.carrying,
          alive: player.alive,
          interacting: false,
        });
      }
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

    this.syncCores(snapshot, frameDelta);
  }

  private createAvatar(role: string, colorway: number): Avatar {
    const group = new THREE.Group();
    let character: Character | null = null;

    if (role === 'drone') {
      const hull = new THREE.Mesh(
        new THREE.CylinderGeometry(DRONE_RADIUS, DRONE_RADIUS * 0.82, DRONE_RADIUS * 0.55, 16),
        new THREE.MeshLambertMaterial({ color: COLOR_PROP }),
      );
      hull.castShadow = true;
      group.add(hull);
    } else if (this.template) {
      // Same animated body as the local runner, so nobody looks different to
      // themselves. Feet on the group origin, which is the collider's centre.
      character = new Character(this.template, this.animations);
      character.setColorway(RUNNER_COLORWAYS[colorway % RUNNER_COLORWAYS.length] ?? COLOR_RUNNER);
      character.object.position.y = -FOOT_OFFSET;
      group.add(character.object);
    } else {
      // The body carries the colourway; the head stays a constant skin tone,
      // so the tint reads as clothing rather than as a different species.
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HALF_HEIGHT * 2),
        new THREE.MeshLambertMaterial({
          color: RUNNER_COLORWAYS[colorway % RUNNER_COLORWAYS.length] ?? COLOR_RUNNER,
        }),
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
    return {
      group,
      target: new THREE.Vector3(),
      targetYaw: 0,
      character,
      previous: new THREE.Vector3(),
      speed: 0,
    };
  }

  /**
   * Hand over the loaded character, once. Avatars created before this keep
   * their primitives; in practice the model lands during the lobby.
   */
  setCharacterTemplate(scene: THREE.Object3D | null, animations: THREE.AnimationClip[]): void {
    this.template = scene;
    this.animations = animations;
  }

  /** Server-owned cores. Local core visuals are disabled while connected. */
  private syncCores(snapshot: NetSnapshot, frameDelta: number): void {
    while (this.coreMeshes.length < snapshot.cores.length) {
      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(CORE_RADIUS, CORE_RADIUS * 1.1),
        new THREE.MeshLambertMaterial({ color: COLOR_CORE, emissive: COLOR_CORE, emissiveIntensity: 0.35 }),
      );
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.coreMeshes.push(mesh);
      this.coreShafts.push(this.createShaft());
    }

    this.shaftClock += frameDelta * CORE_SHAFT_SPIN;
    for (let i = 0; i < this.coreMeshes.length; i += 1) {
      const mesh = this.coreMeshes[i];
      const shaft = this.coreShafts[i];
      const core = snapshot.cores[i];
      if (!mesh) continue;
      if (!core || core.state === 'inserted') {
        mesh.visible = false;
        if (shaft) shaft.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(core.x, core.y, core.z);

      // The shaft only rises over a core somebody is carrying. On the ground a
      // core is a thing to go and get; in someone's hands it is a thing to
      // chase, and that difference has to be legible from across the arena.
      if (!shaft) continue;
      shaft.visible = core.state === 'carried';
      if (shaft.visible) {
        shaft.position.set(core.x, core.y + CORE_SHAFT_HEIGHT / 2, core.z);
        shaft.rotation.y = this.shaftClock;
      }
    }
  }

  /**
   * A tapered, additive, depth-write-free cone. Additive so it brightens
   * whatever is behind it rather than hiding it, and depthWrite off so two
   * shafts crossing do not carve holes in each other.
   */
  private createShaft(): THREE.Mesh {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(CORE_SHAFT_RADIUS * 2.2, CORE_SHAFT_RADIUS, CORE_SHAFT_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: COLOR_CORE_CARRIED,
        transparent: true,
        opacity: CORE_SHAFT_OPACITY,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    shaft.visible = false;
    this.scene.add(shaft);
    return shaft;
  }

  /** Dev-only census, so a test can assert what is actually on screen. */
  census(): {
    avatars: number;
    cores: number;
    corePositions: number[][];
    shafts: number;
    avatarColors: string[];
  } {
    const corePositions = this.coreMeshes
      .filter((mesh) => mesh.visible)
      .map((mesh) => [mesh.position.x, mesh.position.y, mesh.position.z]);
    const avatarColors: string[] = [];
    for (const avatar of this.avatars.values()) {
      // Character avatars carry the tint on the model; primitive ones carry it
      // on their first mesh. Both are runners, and both need reporting.
      if (avatar.character) {
        avatarColors.push(avatar.character.colorwayHex);
        continue;
      }
      const body = avatar.group.children[0] as THREE.Mesh | undefined;
      const material = body?.material as THREE.MeshLambertMaterial | undefined;
      if (material?.color) avatarColors.push(`#${material.color.getHexString()}`);
    }
    return {
      avatars: this.avatars.size,
      cores: corePositions.length,
      corePositions,
      shafts: this.coreShafts.filter((shaft) => shaft.visible).length,
      avatarColors,
    };
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
