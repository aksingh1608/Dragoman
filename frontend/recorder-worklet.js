class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.collecting = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === "start") this.collecting = true;
      if (cmd === "stop") this.collecting = false;
    };
  }

  process(inputs) {
    if (!this.collecting) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    const copy = new Float32Array(ch.length);
    copy.set(ch);
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
