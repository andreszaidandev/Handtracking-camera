import { useEffect, useMemo, useRef, useState } from "react";
import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-webgl";
import * as handPoseDetection from "@tensorflow-models/hand-pose-detection";
import "./CameraTracking.css";

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// MediaPipe Hands keypoint indices (21 points)
const CONNECTIONS = [
  // thumb
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  // index
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  // middle
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  // ring
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  // pinky
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  // palm-ish
  [5, 9],
  [9, 13],
  [13, 17],
];

export default function CameraTracking({ onCapture }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const captureCanvasRef = useRef(null);

  const detectorRef = useRef(null);
  const rafRef = useRef(null);

  const [status, setStatus] = useState("Initializing…");

  // pinching states (true only when pinching)
  const [pinchStates, setPinchStates] = useState({ left: false, right: false });

  // detection states (true when a hand exists on that side)
  const [presentStates, setPresentStates] = useState({
    left: false,
    right: false,
  });

  const [countdown, setCountdown] = useState(null); // 3..2..1

  // tweakables
  const PINCH_THRESHOLD = 0.35;
  const COOLDOWN_MS = 1200;
  const COUNTDOWN_SECONDS = 3;

  const lastCaptureAtRef = useRef(0);

  // each side must release pinch before it can trigger again
  const pinchArmedRef = useRef({ left: true, right: true });

  // countdown refs
  const countdownActiveRef = useRef(false);
  const countdownTimeoutsRef = useRef([]);
  const pendingCaptureRef = useRef(false);

  // keep latest status for drawing (avoid stale closure in drawOverlay)
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const supportsMedia = useMemo(() => {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }, []);

  function clearCountdownTimers() {
    countdownTimeoutsRef.current.forEach((id) => clearTimeout(id));
    countdownTimeoutsRef.current = [];
  }

  function cancelCountdown() {
    clearCountdownTimers();
    countdownActiveRef.current = false;
    pendingCaptureRef.current = false;
    setCountdown(null);
  }

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
      modelType: "lite",
      maxHands: 2,
      solutionPath: "https://cdn.jsdelivr.net/npm/@mediapipe/hands",
    };

    detectorRef.current = await handPoseDetection.createDetector(
      model,
      detectorConfig
    );

    setStatus("Model loaded");
  }

  function captureFrame() {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    const ctx = canvas.getContext("2d");

    // mirror save so it matches what user sees
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

    const ratio = pinchDistance / handScale;
    const isPinch = ratio < PINCH_THRESHOLD;

    return { isPinch, ratio };
  }

  function labelHandsLeftRight(predictions) {
    // Label by wrist.x: smaller x = left side of screen
    const hands = (predictions || [])
      .map((pred) => {
        const kp = pred?.keypoints;
        const wrist = kp?.[0];
        return {
          pred,
          wristX: wrist?.x ?? Number.POSITIVE_INFINITY,
        };
      })
      .filter((h) => h.pred?.keypoints?.length);

    hands.sort((a, b) => a.wristX - b.wristX);

    return {
      left: hands[0]?.pred ?? null,
      right: hands[1]?.pred ?? null,
    };
  }

  function startCountdownAndCapture() {
    if (countdownActiveRef.current) return;

    countdownActiveRef.current = true;
    pendingCaptureRef.current = true;

    setCountdown(COUNTDOWN_SECONDS);
    clearCountdownTimers();

    for (let i = 1; i <= COUNTDOWN_SECONDS; i++) {
      const remaining = COUNTDOWN_SECONDS - i;

      const id = setTimeout(() => {
        if (!countdownActiveRef.current) return;

        if (remaining > 0) {
          setCountdown(remaining);
        } else {
          setCountdown(null);
          countdownActiveRef.current = false;

          if (pendingCaptureRef.current) {
            pendingCaptureRef.current = false;
            captureFrame();
          }
        }
      }, i * 1000);

      countdownTimeoutsRef.current.push(id);
    }
  }

  function drawHand(ctx, pred, label, isPinching) {
    const kp = pred?.keypoints;
    if (!kp || kp.length < 21) return;

    // draw skeleton lines
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const pa = kp[a];
      const pb = kp[b];
      if (!pa || !pb) continue;
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();

    // draw points
    for (const p of kp) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(106,166,255,0.9)";
      ctx.fill();
    }

    // draw pinch line
    const thumbTip = kp[4];
    const indexTip = kp[8];
    ctx.beginPath();
    ctx.moveTo(thumbTip.x, thumbTip.y);
    ctx.lineTo(indexTip.x, indexTip.y);
    ctx.lineWidth = 5;
    ctx.strokeStyle = isPinching
      ? "rgba(0,255,140,0.95)"
      : "rgba(255,255,255,0.35)";
    ctx.stroke();

    // label near wrist
    const wrist = kp[0];
    ctx.font = "16px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fillText(label, wrist.x + 10, wrist.y - 10);
  }

  function drawOverlay(predictions, lr, pinchBySide) {
    const canvas = overlayRef.current;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // status text
    ctx.font = "16px ui-sans-serif, system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(`Status: ${statusRef.current}`, 14, 26);

    // draw hands (left/right)
    if (lr.left) drawHand(ctx, lr.left, "Left", pinchBySide.left);
    if (lr.right) drawHand(ctx, lr.right, "Right", pinchBySide.right);
  }

  async function loop() {
    const detector = detectorRef.current;
    const video = videoRef.current;

    if (!detector || !video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(loop);
      return;
    }

    const predictions = await detector.estimateHands(video, {
      flipHorizontal: true,
    });

    const lr = labelHandsLeftRight(predictions);

    const leftPresent = !!lr.left;
    const rightPresent = !!lr.right;

    const leftPinch = lr.left ? computePinch(lr.left).isPinch : false;
    const rightPinch = lr.right ? computePinch(lr.right).isPinch : false;

    const pinchBySide = { left: leftPinch, right: rightPinch };

    setPresentStates({ left: leftPresent, right: rightPresent });
    setPinchStates(pinchBySide);

    // capture trigger: pinch edge (per side) + global cooldown + not already counting down
    const now = Date.now();
    const cooledDown = now - lastCaptureAtRef.current > COOLDOWN_MS;

    const tryTrigger = (side) => {
      const isPinchNow = pinchBySide[side];
      const armed = pinchArmedRef.current[side];

      if (!isPinchNow) {
        pinchArmedRef.current[side] = true;
        return;
      }

      if (isPinchNow && armed && cooledDown && !countdownActiveRef.current) {
        lastCaptureAtRef.current = now;
        pinchArmedRef.current[side] = false;
        startCountdownAndCapture();
      }
    };

    tryTrigger("left");
    tryTrigger("right");

    // ✅ IMPORTANT: actually draw overlay
    drawOverlay(predictions, lr, pinchBySide);

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

        setStatus("Tracking… pinch (either hand) to start 3s timer");
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

      cancelCountdown();

      if (rafRef.current) cancelAnimationFrame(rafRef.current);

      const v = videoRef.current;
      if (v?.srcObject) {
        const tracks = v.srcObject.getTracks?.() || [];
        tracks.forEach((t) => t.stop());
      }

      detectorRef.current?.dispose?.();
      detectorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportsMedia]);

  const anyPinching = pinchStates.left || pinchStates.right;

  return (
    <div className="ct-root">
      <div className="ct-frame">
        <video ref={videoRef} playsInline muted className="ct-video" />
        <canvas ref={overlayRef} className="ct-overlay" />

        {countdown !== null && (
          <div className="ct-countdown" aria-live="polite">
            {countdown}
          </div>
        )}
      </div>

      <div className="ct-footer">
        <div className="ct-status">{status}</div>

        <div className="ct-rightPills">
          <div className={`ct-pill ${anyPinching ? "ct-pill--pinch" : ""}`}>
            {anyPinching ? "PINCH" : "open"}
          </div>

          <div className="ct-lr">
            <span
              className={`ct-lrTag ${
                presentStates.left ? "is-detected" : ""
              } ${pinchStates.left ? "is-on" : ""}`}
            >
              Left
            </span>
            <span
              className={`ct-lrTag ${
                presentStates.right ? "is-detected" : ""
              } ${pinchStates.right ? "is-on" : ""}`}
            >
              Right
            </span>
          </div>
        </div>
      </div>

      <canvas ref={captureCanvasRef} className="ct-hiddenCanvas" />
    </div>
  );
}