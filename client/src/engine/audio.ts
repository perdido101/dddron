import * as THREE from 'three';

import {
  PROP_AUDIBLE_RADIUS,
  PROP_PITCH_MAX,
  PROP_PITCH_MIN,
  PROP_WHINE_BASE_HZ,
  PROP_WHINE_DETUNE,
  PROP_WHINE_FILTER_HZ,
  PROP_WHINE_GAIN,
  PROP_WHINE_LAYERS,
  TELEGRAPH_WARBLE_DEPTH,
  TELEGRAPH_WARBLE_HZ,
} from '@shared/constants';

/**
 * Prop whine, synthesised rather than sampled.
 *
 * The asset manifest is explicit about this: a looped sample cannot do
 * continuous pitch shift convincingly, and locating the drone by ear is a
 * mechanic, not polish (phase 3 acceptance). So this is layered detuned
 * oscillators through a lowpass, positioned with a real PannerNode so the
 * browser does the distance attenuation and stereo placement for us.
 *
 * Browsers refuse to start audio without a user gesture, so everything is
 * built lazily on the first interaction and `running` stays false until then.
 */
export class PropWhine {
  private context: AudioContext | null = null;
  private panner: PannerNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private readonly oscillators: OscillatorNode[] = [];
  private warble: OscillatorNode | null = null;
  private warbleGain: GainNode | null = null;

  /** Start (or resume) the audio graph. Must be called from a user gesture. */
  start(): void {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return;
    }

    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    this.context = context;

    this.gain = context.createGain();
    this.gain.gain.value = 0;

    this.filter = context.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = PROP_WHINE_FILTER_HZ;

    this.panner = context.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 1;
    this.panner.maxDistance = PROP_AUDIBLE_RADIUS;
    this.panner.rolloffFactor = 1;

    // A detuned stack reads as "several small motors", which one oscillator
    // never does. The slight beating between layers is most of the character.
    for (let i = 0; i < PROP_WHINE_LAYERS; i += 1) {
      const osc = context.createOscillator();
      osc.type = i % 2 === 0 ? 'sawtooth' : 'square';
      osc.frequency.value = PROP_WHINE_BASE_HZ;
      osc.detune.value = (i - (PROP_WHINE_LAYERS - 1) / 2) * PROP_WHINE_DETUNE;
      osc.connect(this.filter);
      osc.start();
      this.oscillators.push(osc);
    }

    // Battery-low warble, layered under the whine during the telegraph.
    this.warble = context.createOscillator();
    this.warble.type = 'sine';
    this.warble.frequency.value = TELEGRAPH_WARBLE_HZ;
    this.warbleGain = context.createGain();
    this.warbleGain.gain.value = 0;
    this.warble.connect(this.warbleGain);
    for (const osc of this.oscillators) this.warbleGain.connect(osc.frequency);
    this.warble.start();

    this.filter.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(context.destination);
  }

  get running(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /**
   * @param throttle 0-1, how hard the rotors are working.
   * @param telegraph 0-1, how far into the final seconds of the fuse.
   * @param muted silences the whine (drone dead or docked) without tearing down.
   */
  update(
    source: THREE.Vector3,
    listener: THREE.Camera,
    throttle: number,
    telegraph: number,
    muted: boolean,
  ): void {
    const context = this.context;
    if (!context || !this.panner || !this.gain || !this.warbleGain) return;

    const now = context.currentTime;
    this.panner.positionX.setTargetAtTime(source.x, now, AUDIO_SMOOTHING);
    this.panner.positionY.setTargetAtTime(source.y, now, AUDIO_SMOOTHING);
    this.panner.positionZ.setTargetAtTime(source.z, now, AUDIO_SMOOTHING);

    // Keep the browser's listener glued to the camera so left/right and
    // near/far are computed from what the player is actually looking at.
    const audioListener = context.listener;
    listener.getWorldPosition(LISTENER_POSITION);
    listener.getWorldDirection(LISTENER_FORWARD);
    LISTENER_UP.set(0, 1, 0).applyQuaternion(listener.quaternion);

    if (audioListener.positionX) {
      audioListener.positionX.setTargetAtTime(LISTENER_POSITION.x, now, AUDIO_SMOOTHING);
      audioListener.positionY.setTargetAtTime(LISTENER_POSITION.y, now, AUDIO_SMOOTHING);
      audioListener.positionZ.setTargetAtTime(LISTENER_POSITION.z, now, AUDIO_SMOOTHING);
      audioListener.forwardX.setTargetAtTime(LISTENER_FORWARD.x, now, AUDIO_SMOOTHING);
      audioListener.forwardY.setTargetAtTime(LISTENER_FORWARD.y, now, AUDIO_SMOOTHING);
      audioListener.forwardZ.setTargetAtTime(LISTENER_FORWARD.z, now, AUDIO_SMOOTHING);
      audioListener.upX.value = LISTENER_UP.x;
      audioListener.upY.value = LISTENER_UP.y;
      audioListener.upZ.value = LISTENER_UP.z;
    } else {
      // Safari still ships the deprecated setter-based API.
      audioListener.setPosition(LISTENER_POSITION.x, LISTENER_POSITION.y, LISTENER_POSITION.z);
      audioListener.setOrientation(
        LISTENER_FORWARD.x, LISTENER_FORWARD.y, LISTENER_FORWARD.z,
        LISTENER_UP.x, LISTENER_UP.y, LISTENER_UP.z,
      );
    }

    // Pitch rises with throttle, and again as the fuse runs out — the audible
    // half of the telegraph.
    const pitch = PROP_PITCH_MIN + (PROP_PITCH_MAX - PROP_PITCH_MIN) * Math.min(throttle + telegraph, 1);
    for (const osc of this.oscillators) {
      osc.frequency.setTargetAtTime(PROP_WHINE_BASE_HZ * pitch, now, AUDIO_SMOOTHING);
    }
    this.warbleGain.gain.setTargetAtTime(telegraph * TELEGRAPH_WARBLE_DEPTH, now, AUDIO_SMOOTHING);
    this.gain.gain.setTargetAtTime(muted ? 0 : PROP_WHINE_GAIN, now, AUDIO_SMOOTHING);
  }
}

/** Time constant for every audio ramp; avoids zipper noise on fast changes. */
const AUDIO_SMOOTHING = 0.03;

const LISTENER_POSITION = new THREE.Vector3();
const LISTENER_FORWARD = new THREE.Vector3();
const LISTENER_UP = new THREE.Vector3();
