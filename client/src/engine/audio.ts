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

  /** The shared AudioContext, so one-shots ride the same graph. */
  get audioContext(): AudioContext | null {
    return this.context;
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

/**
 * One-shot effects.
 *
 * The asset manifest routes the detonation pop, core clicks and EMP fire to
 * ElevenLabs files. Those are not sourced yet — the manifest's own rule is to
 * acquire nothing before phase 9 is signed off — so these are synthesised
 * stand-ins that occupy the right slots in the mix. The EMP charge whine and
 * the UI clicks are marked WEBAUDIO in the manifest and are meant to stay
 * synthesised permanently.
 */
export class Sfx {
  private context: AudioContext | null = null;
  private empGain: GainNode | null = null;
  private empOsc: OscillatorNode | null = null;

  attach(context: AudioContext | null): void {
    if (!context || this.context) return;
    this.context = context;

    // The EMP charge whine is a continuous rising sawtooth, so it lives as a
    // permanent voice whose gain and pitch are driven by charge progress.
    this.empOsc = context.createOscillator();
    this.empOsc.type = 'sawtooth';
    this.empOsc.frequency.value = EMP_WHINE_BASE_HZ;
    this.empGain = context.createGain();
    this.empGain.gain.value = 0;
    this.empOsc.connect(this.empGain);
    this.empGain.connect(context.destination);
    this.empOsc.start();
  }

  /** PLACEHOLDER for the ElevenLabs "detonation pop" — party popper, not a bomb. */
  detonation(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;

    // Short noise burst with a fast decay: a pop, not an explosion.
    const length = Math.floor(context.sampleRate * POP_SECONDS);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** POP_DECAY;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = POP_FILTER_HZ;
    const gain = context.createGain();
    gain.gain.value = POP_GAIN;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(now);
  }

  /** PLACEHOLDER for the ElevenLabs core pickup / insert clicks. */
  click(pitch: number): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const osc = context.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(CLICK_BASE_HZ * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(CLICK_BASE_HZ * pitch * 0.5, now + CLICK_SECONDS);
    const gain = context.createGain();
    gain.gain.setValueAtTime(CLICK_GAIN, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + CLICK_SECONDS);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(now);
    osc.stop(now + CLICK_SECONDS);
  }

  /**
   * PLACEHOLDER for the ElevenLabs "swat whoosh" — the swing, whether or not
   * it lands. Filtered noise swept downward: air moving past a hand.
   */
  whoosh(): void {
    this.noiseBurst(WHOOSH_SECONDS, WHOOSH_GAIN, WHOOSH_FROM_HZ, WHOOSH_TO_HZ, 'bandpass');
  }

  /**
   * PLACEHOLDER for the ElevenLabs "swat connect" — heavier than the whoosh,
   * with a low thud under it so a hit is audibly different from a miss.
   */
  thud(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    this.noiseBurst(THUD_SECONDS, THUD_GAIN, THUD_FROM_HZ, THUD_TO_HZ, 'lowpass');

    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(THUD_TONE_HZ, now);
    osc.frequency.exponentialRampToValueAtTime(THUD_TONE_HZ * 0.4, now + THUD_SECONDS);
    const gain = context.createGain();
    gain.gain.setValueAtTime(THUD_GAIN, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + THUD_SECONDS);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(now);
    osc.stop(now + THUD_SECONDS);
  }

  /**
   * PLACEHOLDER for the ElevenLabs "core drop / fumble". Deliberately a
   * downward clatter: losing a core has to sound like a loss, or a player
   * blown off a pad will not notice they are no longer carrying anything.
   */
  fumble(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    for (let i = 0; i < FUMBLE_TAPS; i += 1) {
      const osc = context.createOscillator();
      osc.type = 'square';
      const at = now + i * FUMBLE_SPACING;
      osc.frequency.setValueAtTime(FUMBLE_BASE_HZ * (1 - i * FUMBLE_FALL), at);
      const gain = context.createGain();
      gain.gain.setValueAtTime(FUMBLE_GAIN * (1 - i / FUMBLE_TAPS), at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + FUMBLE_SPACING);
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start(at);
      osc.stop(at + FUMBLE_SPACING);
    }
  }

  /**
   * Shared shape for the noise-based effects: a burst whose filter sweeps
   * between two frequencies. Every "whoosh"-family sound is this with
   * different numbers, so they stay a family rather than four unrelated hacks.
   */
  private noiseBurst(
    seconds: number,
    peak: number,
    fromHz: number,
    toHz: number,
    filterType: BiquadFilterType,
  ): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;

    const length = Math.floor(context.sampleRate * seconds);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(fromHz, now);
    filter.frequency.exponentialRampToValueAtTime(toHz, now + seconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(context.destination);
    source.start(now);
  }

  /** @param charge 0-1 across EMP_CHARGE_TIME; rises into the fire. */
  setEmpCharge(charge: number): void {
    const context = this.context;
    if (!context || !this.empGain || !this.empOsc) return;
    const now = context.currentTime;
    this.empGain.gain.setTargetAtTime(charge > 0 ? charge * EMP_WHINE_GAIN : 0, now, AUDIO_SMOOTHING);
    this.empOsc.frequency.setTargetAtTime(
      EMP_WHINE_BASE_HZ + charge * EMP_WHINE_RISE_HZ,
      now,
      AUDIO_SMOOTHING,
    );
  }
}

const POP_SECONDS = 0.28;
const POP_DECAY = 3;
const POP_FILTER_HZ = 900;
const POP_GAIN = 0.35;
const CLICK_BASE_HZ = 660;
const CLICK_SECONDS = 0.07;
const CLICK_GAIN = 0.12;
/** Swat swing: a fast downward sweep, so it reads as air rather than impact. */
const WHOOSH_SECONDS = 0.18;
const WHOOSH_GAIN = 0.16;
const WHOOSH_FROM_HZ = 2600;
const WHOOSH_TO_HZ = 400;
/** Swat connect: longer, lower, with a sine thud beneath the noise. */
const THUD_SECONDS = 0.22;
const THUD_GAIN = 0.3;
const THUD_FROM_HZ = 1400;
const THUD_TO_HZ = 180;
const THUD_TONE_HZ = 150;
/** Core fumble: a descending clatter of square taps. */
const FUMBLE_TAPS = 4;
const FUMBLE_SPACING = 0.045;
const FUMBLE_BASE_HZ = 520;
const FUMBLE_FALL = 0.17;
const FUMBLE_GAIN = 0.13;
const EMP_WHINE_BASE_HZ = 90;
const EMP_WHINE_RISE_HZ = 620;
const EMP_WHINE_GAIN = 0.1;

/** Time constant for every audio ramp; avoids zipper noise on fast changes. */
const AUDIO_SMOOTHING = 0.03;

const LISTENER_POSITION = new THREE.Vector3();
const LISTENER_FORWARD = new THREE.Vector3();
const LISTENER_UP = new THREE.Vector3();
