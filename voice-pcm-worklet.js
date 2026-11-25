/* Streaming mono PCM16LE at 16 kHz, using the actual AudioContext sample rate. */
class FamilyVoicePcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options && options.processorOptions || {};
    this.rate = config.targetSampleRate || 16000;
    this.frameSamples = config.frameSamples || 800;
    this.step = sampleRate / this.rate;
    this.direct = sampleRate === this.rate;
    this.totalInput = 0;
    this.totalOutput = 0;
    this.used = 0;
    this.done = false;
    this.buffer = new ArrayBuffer(this.frameSamples * 2);
    this.view = new DataView(this.buffer);
    this.ring = new Float32Array(512);
    this.half = 64;
    this.phases = 256;
    this.filters = this.direct ? null : this.makeFilters();
    this.port.onmessage = event => {
      if (this.done) return;
      if (event.data && event.data.type === 'flush') this.flush();
      else if (event.data && event.data.type === 'abort') this.done = true;
    };
  }
  makeFilters() {
    // A Blackman-windowed sinc rejects frequencies above the new Nyquist rate.
    // Decimating without this filter aliases high-frequency noise into speech.
    const cutoff = 0.45 * Math.min(1, this.rate / sampleRate);
    const filters = [];
    for (let phase = 0; phase < this.phases; phase++) {
      const taps = new Float64Array(this.half * 2);
      let sum = 0;
      for (let i = 0; i < taps.length; i++) {
        const distance = i - this.half + 1 - phase / this.phases;
        const window = Math.abs(distance) > this.half ? 0 :
          0.42 + 0.5 * Math.cos(Math.PI * distance / this.half) + 0.08 * Math.cos(2 * Math.PI * distance / this.half);
        const value = Math.abs(distance) < 1e-10 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        taps[i] = value * window; sum += taps[i];
      }
      for (let i = 0; i < taps.length; i++) taps[i] /= sum;
      filters.push(taps);
    }
    return filters;
  }
  emit(sample) {
    sample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    this.view.setInt16(this.used * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    this.used++; this.totalOutput++;
    if (this.used === this.frameSamples) this.sendFrame();
  }
  sendFrame() {
    if (!this.used) return;
    const buffer = this.used === this.frameSamples ? this.buffer : this.buffer.slice(0, this.used * 2);
    this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
    this.buffer = new ArrayBuffer(this.frameSamples * 2);
    this.view = new DataView(this.buffer); this.used = 0;
  }
  resample() {
    const position = this.totalOutput * this.step, center = Math.floor(position);
    const phase = Math.min(this.phases - 1, Math.floor((position - center) * this.phases));
    const taps = this.filters[phase];
    let value = 0;
    for (let i = 0; i < taps.length; i++) {
      const index = center + i - this.half + 1;
      if (index >= 0 && index < this.totalInput) value += this.ring[index % this.ring.length] * taps[i];
    }
    this.emit(value);
  }
  flush() {
    this.done = true;
    if (!this.direct) {
      const count = Math.round(this.totalInput / this.step);
      while (this.totalOutput < count) this.resample();
    }
    this.sendFrame();
    this.port.postMessage({ type: 'flushed' });
  }
  process(inputs, outputs) {
    if (this.done) return false;
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += Number.isFinite(channel[i]) ? channel[i] : 0;
      sample /= channels.length;
      if (this.direct) { this.totalInput++; this.emit(sample); }
      else {
        this.ring[this.totalInput % this.ring.length] = sample; this.totalInput++;
        while (Math.floor(this.totalOutput * this.step) + this.half < this.totalInput) this.resample();
      }
    }
    return true;
  }
}
registerProcessor('family-voice-pcm', FamilyVoicePcm);
