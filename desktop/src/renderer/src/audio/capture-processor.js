// Runs on the dedicated Web Audio rendering thread (AudioWorkletGlobalScope).
// Deliberately does ONLY real-time-safe capture: copy each 128-sample
// render quantum's per-channel data and post it to the main thread. No
// resampling, no chunking, no networking, no AI — all of that happens
// later on the regular JS thread (see ChunkAccumulator.ts, pcm.ts,
// EngineClient.ts), where occasional GC pauses or slow work can't cause
// audible dropouts in the audio callback itself.
class VoiceshiftCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const channels = [];
      for (let ch = 0; ch < input.length; ch++) {
        channels.push(input[ch].slice());
      }
      this.port.postMessage({ channels, sampleRate });
    }
    return true;
  }
}

registerProcessor("voiceshift-capture-processor", VoiceshiftCaptureProcessor);
