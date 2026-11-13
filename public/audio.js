(function (root) {
  'use strict';

  class CasinoAudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.compressor = null;
      this.bgmBus = null;
      this.sfxBus = null;
      this.reverbSend = null;
      this.noiseBuffer = null;

      this.bgmEnabled = true;
      this.sfxEnabled = true;
      this.bgmVolume = 0.34;
      this.sfxVolume = 0.78;
      this.track = 'nujazz'; // 'nujazz' | 'deephouse'

      this.isPlayingBgm = false;
      this.schedulerId = null;
      this.nextStepTime = 0;
      this.stepIndex = 0;
      this.initialized = false;
    }

    ensureContext() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();

        this.compressor = this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -16;
        this.compressor.knee.value = 18;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.004;
        this.compressor.release.value = 0.18;

        this.master = this.ctx.createGain();
        this.master.gain.value = 0.92;

        this.bgmBus = this.ctx.createGain();
        this.bgmBus.gain.value = this.bgmEnabled ? this.bgmVolume : 0;

        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = this.sfxEnabled ? this.sfxVolume : 0;

        // Warm lounge stereo-feel echo bus
        this.reverbSend = this.ctx.createGain();
        this.reverbSend.gain.value = 0.28;
        const delayL = this.ctx.createDelay(1.0);
        const delayR = this.ctx.createDelay(1.0);
        delayL.delayTime.value = 0.24;
        delayR.delayTime.value = 0.36;
        const fbL = this.ctx.createGain();
        const fbR = this.ctx.createGain();
        fbL.gain.value = 0.28;
        fbR.gain.value = 0.24;
        const echoFilter = this.ctx.createBiquadFilter();
        echoFilter.type = 'lowpass';
        echoFilter.frequency.value = 2100;

        this.reverbSend.connect(delayL);
        this.reverbSend.connect(delayR);
        delayL.connect(fbL);
        fbL.connect(delayR);
        delayR.connect(fbR);
        fbR.connect(delayL);
        delayL.connect(echoFilter);
        delayR.connect(echoFilter);
        echoFilter.connect(this.compressor);

        this.bgmBus.connect(this.compressor);
        this.sfxBus.connect(this.compressor);
        this.compressor.connect(this.master);
        this.master.connect(this.ctx.destination);

        this.noiseBuffer = this._createNoiseBuffer(2.0);
        this.initialized = true;
      }

      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    unlockAndStartBgm() {
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (this.bgmEnabled && !this.isPlayingBgm) {
        this.startBgm();
      }
    }

    _createNoiseBuffer(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      return buf;
    }

    setBgmEnabled(enabled) {
      this.bgmEnabled = Boolean(enabled);
      if (this.bgmBus && this.ctx) {
        this.bgmBus.gain.setTargetAtTime(this.bgmEnabled ? this.bgmVolume : 0, this.ctx.currentTime, 0.08);
      }
      if (this.bgmEnabled) {
        this.ensureContext();
        this.startBgm();
      } else {
        this.stopBgm();
      }
    }

    setSfxEnabled(enabled) {
      this.sfxEnabled = Boolean(enabled);
      if (this.sfxBus && this.ctx) {
        this.sfxBus.gain.setTargetAtTime(this.sfxEnabled ? this.sfxVolume : 0, this.ctx.currentTime, 0.04);
      }
    }

    setTrack(trackName) {
      if (trackName !== 'nujazz' && trackName !== 'deephouse') return;
      this.track = trackName;
      this.stepIndex = 0;
      if (this.isPlayingBgm) {
        this.stopBgm();
        this.startBgm();
      }
    }

    setBgmVolume(val) {
      this.bgmVolume = Math.max(0, Math.min(1, Number(val)));
      if (this.bgmBus && this.ctx && this.bgmEnabled) {
        this.bgmBus.gain.setTargetAtTime(this.bgmVolume, this.ctx.currentTime, 0.05);
      }
    }

    startBgm() {
      const ctx = this.ensureContext();
      if (!ctx || this.isPlayingBgm || !this.bgmEnabled) return;
      this.isPlayingBgm = true;
      this.nextStepTime = ctx.currentTime + 0.06;
      this.stepIndex = 0;

      const lookaheadMs = 60;
      const scheduleAheadSec = 0.18;

      this.schedulerId = setInterval(() => {
        if (!this.isPlayingBgm || !this.ctx || this.ctx.state !== 'running') return;
        while (this.nextStepTime < this.ctx.currentTime + scheduleAheadSec) {
          this._scheduleBgmStep(this.stepIndex, this.nextStepTime);
          const bpm = this.track === 'nujazz' ? 94 : 114;
          const sixteenth = 60 / bpm / 4;
          // Subtle swing on odd 16th notes for Nu-Jazz
          let swingOffset = 0;
          if (this.track === 'nujazz') {
            swingOffset = this.stepIndex % 2 === 0 ? sixteenth * 0.14 : -sixteenth * 0.14;
          }
          this.nextStepTime += sixteenth + swingOffset;
          this.stepIndex = (this.stepIndex + 1) % 64;
        }
      }, lookaheadMs);
    }

    stopBgm() {
      this.isPlayingBgm = false;
      if (this.schedulerId) {
        clearInterval(this.schedulerId);
        this.schedulerId = null;
      }
    }

    _midiToFreq(midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    _playRhodesNote(time, midi, duration, gainPeak = 0.09, bus = this.bgmBus) {
      const ctx = this.ctx;
      const freq = this._midiToFreq(midi);

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freq, time);

      // Subtle bell tine harmonic
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, time);

      const tineGain = ctx.createGain();
      tineGain.gain.setValueAtTime(gainPeak * 0.35, time);
      tineGain.gain.exponentialRampToValueAtTime(0.0008, time + Math.min(0.16, duration * 0.4));

      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, time);
      bodyGain.gain.linearRampToValueAtTime(gainPeak, time + 0.015);
      bodyGain.gain.exponentialRampToValueAtTime(gainPeak * 0.55, time + duration * 0.45);
      bodyGain.gain.exponentialRampToValueAtTime(0.0005, time + duration);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2400, time);
      filter.frequency.exponentialRampToValueAtTime(950, time + duration);

      osc1.connect(bodyGain);
      osc2.connect(tineGain);
      tineGain.connect(filter);
      bodyGain.connect(filter);
      filter.connect(bus);
      filter.connect(this.reverbSend);

      osc1.start(time);
      osc2.start(time);
      osc1.stop(time + duration + 0.04);
      osc2.stop(time + duration + 0.04);
    }

    _playBassNote(time, midi, duration, gainPeak = 0.16) {
      const ctx = this.ctx;
      const freq = this._midiToFreq(midi);
      const osc = ctx.createOscillator();
      osc.type = this.track === 'deephouse' ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(freq, time);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(this.track === 'deephouse' ? 420 : 520, time);
      filter.frequency.exponentialRampToValueAtTime(160, time + duration);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, time);
      g.gain.linearRampToValueAtTime(gainPeak, time + 0.014);
      g.gain.exponentialRampToValueAtTime(0.001, time + duration);

      osc.connect(filter);
      filter.connect(g);
      g.connect(this.bgmBus);

      osc.start(time);
      osc.stop(time + duration + 0.03);
    }

    _playKick(time, gainPeak = 0.25) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(115, time);
      osc.frequency.exponentialRampToValueAtTime(44, time + 0.11);

      const g = ctx.createGain();
      g.gain.setValueAtTime(gainPeak, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.24);

      osc.connect(g);
      g.connect(this.bgmBus);
      osc.start(time);
      osc.stop(time + 0.26);
    }

    _playBrushHat(time, open = false, gainPeak = 0.032) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(open ? 5200 : 7200, time);

      const g = ctx.createGain();
      const dur = open ? 0.14 : 0.04;
      g.gain.setValueAtTime(gainPeak, time);
      g.gain.exponentialRampToValueAtTime(0.0005, time + dur);

      src.connect(hp);
      hp.connect(g);
      g.connect(this.bgmBus);
      src.start(time);
      src.stop(time + dur + 0.02);
    }

    _playRimSnap(time, gainPeak = 0.06) {
      const ctx = this.ctx;
      // Soft cocktail lounge finger-snap / rim click
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(980, time);
      osc.frequency.exponentialRampToValueAtTime(340, time + 0.035);

      const g = ctx.createGain();
      g.gain.setValueAtTime(gainPeak, time);
      g.gain.exponentialRampToValueAtTime(0.0008, time + 0.06);

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2400, time);
      bp.Q.value = 2.2;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(gainPeak * 0.5, time);
      ng.gain.exponentialRampToValueAtTime(0.0005, time + 0.05);

      osc.connect(g);
      g.connect(this.bgmBus);
      src.connect(bp);
      bp.connect(ng);
      ng.connect(this.bgmBus);
      ng.connect(this.reverbSend);

      osc.start(time);
      src.start(time);
      osc.stop(time + 0.07);
      src.stop(time + 0.07);
    }

    _scheduleBgmStep(step, time) {
      const bar = Math.floor(step / 16); // 0..3
      const stepInBar = step % 16;

      if (this.track === 'nujazz') {
        // Progression: Fm9 -> Bb13 -> EbMaj9 -> C7#9
        const chords = [
          [65, 68, 72, 75, 79], // Fm9
          [62, 65, 68, 74, 79], // Bb13
          [63, 67, 70, 74, 77], // EbMaj9
          [64, 67, 70, 75, 80]  // C7alt
        ];
        const bassRoots = [41, 46, 39, 36]; // F2, Bb2, Eb2, C2

        // Syncopated neo-soul Rhodes stabs
        if (stepInBar === 0 || stepInBar === 6 || stepInBar === 11) {
          const dur = stepInBar === 0 ? 0.85 : 0.42;
          const vel = stepInBar === 0 ? 0.055 : 0.04;
          chords[bar].forEach((m, idx) => {
            this._playRhodesNote(time + idx * 0.012, m, dur, vel);
          });
        }
        // Subtle top melody sparkle
        if (stepInBar === 3 || stepInBar === 14) {
          const topNotes = [84, 82, 84, 83];
          this._playRhodesNote(time, topNotes[bar], 0.35, 0.032);
        }

        // Walking groove bass
        if (stepInBar === 0) this._playBassNote(time, bassRoots[bar], 0.55, 0.14);
        if (stepInBar === 6) this._playBassNote(time, bassRoots[bar] + 7, 0.25, 0.11);
        if (stepInBar === 10) this._playBassNote(time, bassRoots[bar] + 5, 0.25, 0.11);
        if (stepInBar === 14) this._playBassNote(time, bassRoots[bar] + 10, 0.18, 0.09);

        // Laid-back lounge beat
        if (stepInBar === 0 || stepInBar === 10) this._playKick(time, 0.20);
        if (stepInBar === 4 || stepInBar === 12) this._playRimSnap(time, 0.048);
        if (stepInBar % 2 === 0) this._playBrushHat(time, stepInBar === 14, stepInBar % 4 === 0 ? 0.024 : 0.014);
      } else {
        // High-Roller Deep House: Dm9 -> Gm9 -> BbMaj7 -> A7sus4
        const chords = [
          [62, 65, 69, 72, 76], // Dm9
          [67, 70, 74, 77, 81], // Gm9
          [62, 65, 69, 70, 74], // BbMaj7
          [62, 64, 67, 69, 74]  // A7sus4
        ];
        const bassRoots = [38, 43, 46, 45];

        if (stepInBar === 0 || stepInBar === 3 || stepInBar === 6 || stepInBar === 12) {
          const vel = stepInBar === 0 ? 0.055 : 0.038;
          chords[bar].forEach((m, idx) => {
            this._playRhodesNote(time + idx * 0.008, m, 0.34, vel);
          });
        }

        // Pumping deep house bassline
        if (stepInBar === 2 || stepInBar === 6 || stepInBar === 10 || stepInBar === 14) {
          const note = stepInBar === 14 ? bassRoots[bar] + 7 : bassRoots[bar];
          this._playBassNote(time, note, 0.22, 0.16);
        }

        // Four-on-the-floor kick + crisp offbeat hats
        if (stepInBar % 4 === 0) this._playKick(time, 0.26);
        if (stepInBar === 4 || stepInBar === 12) this._playRimSnap(time, 0.06);
        if (stepInBar % 4 === 2) this._playBrushHat(time, true, 0.036);
        else if (stepInBar % 2 === 1) this._playBrushHat(time, false, 0.014);
      }
    }

    // --- TACTILE CASINO SFX ---

    playHover() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(520, t + 0.025);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.035, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
      osc.connect(g);
      g.connect(this.sfxBus);
      osc.start(t);
      osc.stop(t + 0.035);
    }

    playDiceRoll(diceCount = 6) {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      // Initial leather cup shake whoosh
      const shakeSrc = ctx.createBufferSource();
      shakeSrc.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1400, now);
      bp.Q.value = 1.4;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, now);
      sg.gain.linearRampToValueAtTime(0.12, now + 0.04);
      sg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      shakeSrc.connect(bp);
      bp.connect(sg);
      sg.connect(this.sfxBus);
      shakeSrc.start(now);
      shakeSrc.stop(now + 0.2);

      // Multi-tap acrylic dice bounces on velvet felt
      const taps = Math.min(14, Math.max(5, diceCount + 3));
      for (let i = 0; i < taps; i++) {
        const delay = 0.07 + i * 0.042 + Math.random() * 0.022;
        const t = now + delay;
        const decayFactor = 1 - i / (taps + 2);

        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const basePitch = 520 + Math.random() * 680;
        osc.frequency.setValueAtTime(basePitch, t);
        osc.frequency.exponentialRampToValueAtTime(basePitch * 0.45, t + 0.025);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.11 * decayFactor, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        // Low felt thump on first few hits
        if (i < 4) {
          const thump = ctx.createOscillator();
          thump.type = 'sine';
          thump.frequency.setValueAtTime(140, t);
          thump.frequency.exponentialRampToValueAtTime(55, t + 0.045);
          const tg = ctx.createGain();
          tg.gain.setValueAtTime(0.14 * decayFactor, t);
          tg.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
          thump.connect(tg);
          tg.connect(this.sfxBus);
          thump.start(t);
          thump.stop(t + 0.055);
        }

        osc.connect(g);
        g.connect(this.sfxBus);
        g.connect(this.reverbSend);
        osc.start(t);
        osc.stop(t + 0.04);
      }
    }

    playDicePlace(casinoId = 1, count = 1) {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Crisp chip/die lock thud
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(185, t);
      thump.frequency.exponentialRampToValueAtTime(62, t + 0.08);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.24, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
      thump.connect(tg);
      tg.connect(this.sfxBus);
      thump.start(t);
      thump.stop(t + 0.1);

      // Musical lounge chime mapped to casino 1..6 (C pentatonic jazz voicing)
      const scaleMidis = [72, 74, 76, 79, 81, 84];
      const midi = scaleMidis[(casinoId - 1) % 6];
      this._playRhodesNote(t, midi, 0.36, 0.14, this.sfxBus);
      if (count >= 2) {
        this._playRhodesNote(t + 0.04, midi + 7, 0.34, 0.09, this.sfxBus);
      }
    }

    playTieAlert() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Subtle dramatic dissonant lounge stab
      [58, 64].forEach((midi, idx) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(this._midiToFreq(midi), t + idx * 0.06);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1100, t + idx * 0.06);
        filter.frequency.exponentialRampToValueAtTime(280, t + idx * 0.06 + 0.25);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.08, t + idx * 0.06);
        g.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.06 + 0.26);

        osc.connect(filter);
        filter.connect(g);
        g.connect(this.sfxBus);
        osc.start(t + idx * 0.06);
        osc.stop(t + idx * 0.06 + 0.28);
      });
    }

    playCashWin(amount = 50000) {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Crisp banknote snap
      const snap = ctx.createBufferSource();
      snap.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(3200, t);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.14, t);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
      snap.connect(bp);
      bp.connect(sg);
      sg.connect(this.sfxBus);
      snap.start(t);
      snap.stop(t + 0.075);

      // Shimmering jazz chord arpeggio; richer for $70k+
      const notes = amount >= 70000 ? [72, 76, 79, 83, 86, 91] : [72, 76, 79, 84];
      notes.forEach((m, i) => {
        this._playRhodesNote(t + i * 0.045, m, 0.5, 0.11, this.sfxBus);
      });
    }

    playHouseSteal() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      this._playRhodesNote(t, 67, 0.22, 0.1, this.sfxBus);
      this._playRhodesNote(t + 0.09, 63, 0.28, 0.1, this.sfxBus);
    }

    playTurnChime() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      this._playRhodesNote(t, 79, 0.24, 0.11, this.sfxBus);
      this._playRhodesNote(t + 0.09, 86, 0.38, 0.12, this.sfxBus);
    }

    playRoundStart() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;

      // Card riffle shuffle sweep
      for (let i = 0; i < 10; i++) {
        const dt = t + i * 0.025;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(2200 + i * 240, dt);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.08, dt);
        g.gain.exponentialRampToValueAtTime(0.001, dt + 0.022);
        src.connect(bp);
        bp.connect(g);
        g.connect(this.sfxBus);
        src.start(dt);
        src.stop(dt + 0.026);
      }

      [60, 67, 72, 76].forEach((m, i) => {
        this._playRhodesNote(t + 0.2 + i * 0.03, m, 0.55, 0.08, this.sfxBus);
      });
    }

    playVictoryFanfare() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      const fanfare = [
        { m: 72, d: 0.0, l: 0.25 },
        { m: 76, d: 0.09, l: 0.25 },
        { m: 79, d: 0.18, l: 0.25 },
        { m: 84, d: 0.28, l: 0.7 },
        { m: 83, d: 0.32, l: 0.7 },
        { m: 86, d: 0.36, l: 0.9 },
        { m: 91, d: 0.44, l: 1.1 }
      ];
      fanfare.forEach(n => this._playRhodesNote(t + n.d, n.m, n.l, 0.13, this.sfxBus));
    }

    playEmote() {
      if (!this.sfxEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      this._playRhodesNote(t, 88, 0.16, 0.09, this.sfxBus);
    }
  }

  root.CasinoAudio = new CasinoAudioEngine();
})(typeof self !== 'undefined' ? self : this);
