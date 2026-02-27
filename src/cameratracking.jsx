import { useEffect, useMemo, useRef, useState } from "react";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";

/**
 * Pinch detection:
 * - uses distance between thumb tip (4) and index tip (8)
 * - normalized by a hand scale (wrist (0) to middle MCP (9)) so it works at different sizes
 */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export default function CameraTracking({ onCapture }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const captureCanvasRef = useRef(null);

  const detectorRef = useRef(null);
  const rafRef = useRef(null);

  const [status, setStatus] = useState("Initializing…");
  const [pinching, setPinching] = useState(false);

  // Tweakables
  const PINCH_THRESHOLD = 0.35; // lower = harder to trigger
  const COOLDOWN_MS = 1200;

  const lastCaptureAtRef = useRef(0);
  const pinchArmedRef = useRef(true); // require release before another capture

  const supportsMedia = useMemo(() => {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }, []);

  async function setupCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    const video = videoRef.current;
    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();

    // Match overlay/capture canvas to actual video size
    const w = video.videoWidth;
    const h = video.videoHeight;

    overlayRef.current.width = w;
    overlayRef.current.height = h;

    captureCanvasRef.current.width = w;
    captureCanvasRef.current.height = h;

    setStatus("Camera ready");
  }

  async function setupModel() {
    setStatus("Loading model…");
    await tf.setBackend("webgl");
    await tf.ready();

    const model = handPoseDetection.SupportedModels.MediaPipeHands;
    const detectorConfig = {
      runtime: "mediapipe",
      modelType: "lite", // "full" is heavier but can be more accurate
      maxHands: 1,
      solutionPath: "https://cdn.jsdelivr.net/npm/@mediapipe/hands",
    };

    detectorRef.current = await handPoseDetection.createDetector(
      model,
      detectorConfig
    );

    setStatus("Model loaded");
  }

  function drawOverlay(predictions) {
    const canvas = overlayRef.current;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // UI hint
    ctx.font = "16px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`Status: ${status}`, 14, 26);

    if (!predictions || predictions.length === 0) return;

    const kp = predictions[0].keypoints;
    if (!kp) return;

    // Draw keypoints
    for (const p of kp) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(106,166,255,0.9)";
      ctx.fill();
    }

    // Draw pinch line between thumb tip and index tip
    const thumbTip = kp[4];
    const indexTip = kp[8];

    ctx.beginPath();
    ctx.moveTo(thumbTip.x, thumbTip.y);
    ctx.lineTo(indexTip.x, indexTip.y);
    ctx.lineWidth = 4;
    ctx.strokeStyle = pinching ? "rgba(0,255,140,0.9)" : "rgba(255,255,255,0.5)";
    ctx.stroke();

    // Pinch indicator bubble
    ctx.beginPath();
    ctx.arc(indexTip.x, indexTip.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = pinching ? "rgba(0,255,140,0.85)" : "rgba(255,255,255,0.35)";
    ctx.fill();
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    const ctx = canvas.getContext("2d");

    // Mirror horizontally so the saved image matches what user sees
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    onCapture?.(dataUrl);
  }

  function computePinch(pred) {
    const kp = pred?.keypoints;
    if (!kp || kp.length < 10) return { isPinch: false, ratio: Infinity };

    const thumbTip = kp[4];
    const indexTip = kp[8];
    const wrist = kp[0];
    const middleMCP = kp[9];

    const pinchDistance = dist(thumbTip, indexTip);
    const handScale = Math.max(dist(wrist, middleMCP), 1);

    const ratio = pinchDistance / handScale; // normalized
    const isPinch = ratio < PINCH_THRESHOLD;

    return { isPinch, ratio };
  }

  async function loop() {
    const detector = detectorRef.current;
    const video = videoRef.current;

    if (!detector || !video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const predictions = await detector.estimateHands(video, {
      flipHorizontal: true, // mirror for selfie view
    });

    let isPinchNow = false;
    if (predictions && predictions.length > 0) {
      const { isPinch } = computePinch(predictions[0]);
      isPinchNow = isPinch;
    }

    setPinching(isPinchNow);

    // Capture logic: pinch edge (armed -> pinch) + cooldown
    const now = Date.now();
    const cooledDown = now - lastCaptureAtRef.current > COOLDOWN_MS;

    if (isPinchNow && pinchArmedRef.current && cooledDown) {
      lastCaptureAtRef.current = now;
      pinchArmedRef.current = false; // disarm until release
      captureFrame();
    }

    // Re-arm once pinch is released
    if (!isPinchNow) {
      pinchArmedRef.current = true;
    }

    drawOverlay(predictions);

    rafRef.current = requestAnimationFrame(loop);
  }

  useEffect(() => {
    if (!supportsMedia) {
      setStatus("Camera not supported in this browser.");
      return;
    }

    let stopped = false;

    (async () => {
      try {
        await setupCamera();
        if (stopped) return;
        await setupModel();
        if (stopped) return;
        setStatus("Tracking… pinch to capture");
        rafRef.current = requestAnimationFrame(loop);
      } catch (e) {
        console.error(e);
        setStatus(
          "Error: camera/model failed. Check permissions + HTTPS (or localhost)."
        );
      }
    })();

    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      // stop camera
      const v = videoRef.current;
      if (v?.srcObject) {
        const tracks = v.srcObject.getTracks?.() || [];
        tracks.forEach((t) => t.stop());
      }

      // dispose model
      detectorRef.current?.dispose?.();
      detectorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          position: "relative",
          width: "100%",
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        {/* Video (mirrored) */}
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: "100%",
            height: "auto",
            transform: "scaleX(-1)",
            display: "block",
            background: "black",
          }}
        />

        {/* Overlay canvas */}
        <canvas
          ref={overlayRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      </div>

      <div
        style={{
          marginTop: 10,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ color: "rgba(255,255,255,0.75)", fontSize: 13 }}>
          {status}
        </div>

        <div
          style={{
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.10)",
            background: pinching
              ? "rgba(0,255,140,0.12)"
              : "rgba(255,255,255,0.06)",
            color: pinching ? "rgba(0,255,140,0.95)" : "rgba(255,255,255,0.75)",
            fontSize: 12,
            userSelect: "none",
          }}
        >
          {pinching ? "PINCH" : "open"}
        </div>
      </div>

      {/* Hidden canvas for capture */}
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}