// Camera barcode scanning through the BarcodeDetector API where the browser has it (Chrome on Android, some desktops).
// Not available on every phone (notably not Firefox, and iOS Safari support varies): the shell always offers typing a code too.
// Nothing leaves the device: frames are read locally and only the decoded text is used.
export const scanSupported = () => typeof globalThis.BarcodeDetector === 'function' && !!globalThis.navigator?.mediaDevices?.getUserMedia;

/** Start scanning into a <video>. Returns { stop }. onCode(text) is called once per new code; onError(kind) with 'denied' | 'unsupported'. */
export async function startScan(video, { onCode, onError }) {
  if (!scanSupported()) { onError?.('unsupported'); return { stop() {} }; }
  let stream, stopped = false, timer = null;
  const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  try {
    const formats = (await globalThis.BarcodeDetector.getSupportedFormats?.().catch(() => null)) ?? undefined;
    const detector = new globalThis.BarcodeDetector(formats?.length ? { formats } : undefined);
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream; video.setAttribute('playsinline', ''); await video.play();
    let last = '', lastAt = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const found = await detector.detect(video);
        const code = found[0]?.rawValue;
        if (code && (code !== last || Date.now() - lastAt > 2500)) { last = code; lastAt = Date.now(); onCode(code); }
      } catch { /* a frame that cannot be read is skipped */ }
      timer = setTimeout(tick, 250);
    };
    tick();
  } catch (e) {
    stop();
    onError?.(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'denied' : 'unsupported');
  }
  return { stop };
}
