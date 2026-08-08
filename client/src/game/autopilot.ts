import * as THREE from 'three';

import {
  AI_ATTACK_ALTITUDE,
  AI_CHASE_RADIUS,
  AI_PATROL_ALTITUDE,
  AI_WAYPOINTS,
  AI_WAYPOINT_RADIUS,
} from '@shared/constants';

import type { DroneInput } from './drone';
import type { Runner } from './runner';

/**
 * The scripted drone from phase 4.
 *
 * Deliberately stupid: it walks a fixed waypoint loop and drifts toward the
 * nearest runner inside AI_CHASE_RADIUS. No pathfinding, no prediction, no
 * cleverness — the brief is explicit that it exists only to pressure-test the
 * objective, and anything smarter would be a different game.
 *
 * It produces the same DroneInput a human pilot would, so the drone itself
 * cannot tell the difference and the flight model is shared exactly.
 */
export class Autopilot {
  readonly input: DroneInput = { move: new THREE.Vector2(), lift: 0 };
  /** Facing it wants; the drone yaws toward this. */
  yaw = 0;

  private waypoint = 0;

  /**
   * @param position where the drone currently is.
   * @returns the input to fly this step.
   */
  update(position: THREE.Vector3, runners: readonly Runner[]): DroneInput {
    const quarry = this.nearestRunner(position, runners);
    const target = quarry ?? this.currentWaypoint(position);
    const targetAltitude = quarry ? AI_ATTACK_ALTITUDE : AI_PATROL_ALTITUDE;

    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const distance = Math.hypot(dx, dz);

    // Face where it is going, then push straight ahead. The drone's own drift
    // and overshoot supply all the comedy; the AI does not need to help.
    if (distance > 1e-3) this.yaw = Math.atan2(-dx, -dz);

    this.input.move.set(0, distance > 1e-3 ? 1 : 0);
    const altitudeError = targetAltitude - position.y;
    this.input.lift = Math.abs(altitudeError) < ALTITUDE_DEADBAND ? 0 : Math.sign(altitudeError);
    return this.input;
  }

  private nearestRunner(position: THREE.Vector3, runners: readonly Runner[]): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestDistance = AI_CHASE_RADIUS;
    for (const runner of runners) {
      if (!runner.alive) continue;
      const distance = Math.hypot(runner.position.x - position.x, runner.position.z - position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = runner.position;
      }
    }
    return best;
  }

  private currentWaypoint(position: THREE.Vector3): THREE.Vector3 {
    const point = AI_WAYPOINTS[this.waypoint % AI_WAYPOINTS.length] ?? AI_WAYPOINTS[0];
    WAYPOINT.set(point[0], AI_PATROL_ALTITUDE, point[1]);
    if (Math.hypot(position.x - point[0], position.z - point[1]) < AI_WAYPOINT_RADIUS) {
      this.waypoint = (this.waypoint + 1) % AI_WAYPOINTS.length;
    }
    return WAYPOINT;
  }
}

/** Altitude error below which the AI stops fiddling with the throttle. */
const ALTITUDE_DEADBAND = 0.4;
const WAYPOINT = new THREE.Vector3();
