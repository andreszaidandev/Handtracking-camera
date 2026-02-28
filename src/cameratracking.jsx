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

const CONNECTIONS = [
  [0, 1],[1, 2],[2, 3],[3, 4],
  [0, 5],[5, 6],[6, 7],[7, 8],
  [0, 9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5, 9],[9,13],[13,17],
];

export default function CameraTracking({ onCapture, onVideoRectChange }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const captureCanvasRef = useRef(null);

  const detectorRef = useRef(null);
  const rafRef = useRef(null);
  const videoSizeRef = useRef({ width: 1, height: 1 });
  const lastVideoRectRef = useRef(null);
  const reconfiguringCameraRef = useRef(false);
  const stoppedRef = useRef(false);
  const startedRef = useRef(false);
  const [, setStatus] = useState("Initializing...");
  const [countdown, setCountdown] = useState(null);
  const [showStartGate, setShowStartGate] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState("");

  // tweakables
  const OK_TOUCH_THRESHOLD = 0.34;
  const INDEX_CURLED_MAX = 1.2;
  const INDEX_CURLED_MIN = 0.2;
  const THUMB_EXTENSION_MIN = 0.28;
  const THREE_FINGERS_EXTENSION_MIN = 0.95;
  const THREE_FINGERS_TO_CIRCLE_MIN = 0.45;
  const FIST_GUARD_MIN = 0.9;
  const COOLDOWN_MS = 1200;
  const COUNTDOWN_SECONDS = 3;

  // performance: inference throttle
  const INFERENCE_FPS = 15; // try 10-20
  const INFERENCE_INTERVAL_MS = Math.floor(1000 / INFERENCE_FPS);
  const lastInferAtRef = useRef(0);

  // keep latest predictions in refs (draw every frame from refs)
  const lrPredRef = useRef({ left: null, right: null });
  const pinchRef = useRef({ left: false, right: false });

  // capture gating
  const lastCaptureAtRef = useRef(0);
  const pinchArmedRef = useRef({ left: true, right: true });

  // countdown refs
  const countdownActiveRef = useRef(false);
  const countdownTimeoutsRef = useRef([]);
  const pendingCaptureRef = useRef(false);

  const supportsMedia = useMemo(() => {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }, []);
  const isMobileDevice = useMemo(() => {
    const hasCoarsePointer =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches;
    return hasCoarsePointer || (navigator.maxTouchPoints || 0) > 0;
  }, []);
  const isSecureContext = typeof window === "undefined" ? true : window.isSecureContext;

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

  function buildViewportVideoConstraints() {
    const viewportWidth = Math.max(
      1,
      Math.round(window.innerWidth * (window.devicePixelRatio || 1))
    );
    const viewportHeight = Math.max(
      1,
      Math.round(window.innerHeight * (window.devicePixelRatio || 1))
    );

    return {
      facingMode: "user",
      width: { ideal: viewportWidth },
      height: { ideal: viewportHeight },
      aspectRatio: { ideal: viewportWidth / viewportHeight },
    };
  }

  function buildPreferredVideoConstraints() {
    // On mobile, let browser choose native/default camera resolution.
    if (isMobileDevice) {
      return { facingMode: "user" };
    }

    // On desktop/tablet, prefer viewport-like sizing.
    return buildViewportVideoConstraints();
  }

  async function getCameraAccess() {
    const preferredConstraints = buildPreferredVideoConstraints();

    try {
      return await navigator.mediaDevices.getUserMedia({
        video: preferredConstraints,
        audio: false,
      });
    } catch (primaryError) {
      // Fallback constraints for devices that do better with explicit front camera hints.
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      } catch {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    }
  }

  async function applyViewportConstraintsToActiveTrack() {
    if (isMobileDevice) return;

    const stream = videoRef.current?.srcObject;
    const track = stream?.getVideoTracks?.()[0];
    if (!track?.applyConstraints) return;

    try {
      await track.applyConstraints(buildViewportVideoConstraints());
    } catch {
      // Ignore resize/orientation constraint failures; existing stream remains usable.
    }
  }

  async function setupCamera() {
    const stream = await getCameraAccess();

    const video = videoRef.current;
    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    await video.play();

    const w = video.videoWidth;
    const h = video.videoHeight;
    videoSizeRef.current = { width: w, height: h };
    overlayRef.current.width = w;
    overlayRef.current.height = h;

    captureCanvasRef.current.width = w;
    captureCanvasRef.current.height = h;

    setStatus("Camera ready");
  }

  async function reconfigureCameraForViewport() {
    if (!startedRef.current || reconfiguringCameraRef.current) return;
    reconfiguringCameraRef.current = true;

    try {
      const video = videoRef.current;
      if (video?.srcObject) {
        const tracks = video.srcObject.getTracks?.() || [];
        tracks.forEach((t) => t.stop());
      }

      await setupCamera();
    } catch (e) {
      console.error("Camera reconfigure failed:", e);
      const errName = e?.name ? String(e.name) : "UnknownError";
      const errMsg = e?.message ? String(e.message) : "Could not reconfigure camera.";
      setStartError(`${errName}: ${errMsg}`);
    } finally {
      reconfiguringCameraRef.current = false;
    }
  }

  async function setupModel() {
    setStatus("Loading modelâ€¦");
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
    if (!kp || kp.length < 21) return false;

    const thumbTip = kp[4];
    const thumbMcp = kp[2];
    const indexTip = kp[8];
    const indexMcp = kp[5];
    const middleTip = kp[12];
    const middleMcp = kp[9];
    const middlePip = kp[10];
    const ringTip = kp[16];
    const ringMcp = kp[13];
    const ringPip = kp[14];
    const pinkyTip = kp[20];
    const pinkyMcp = kp[17];
    const pinkyPip = kp[18];
    const wrist = kp[0];

    const pinchDistance = dist(thumbTip, indexTip);
    const handScale = Math.max(dist(wrist, middleMcp), 1);
    const touchRatio = pinchDistance / handScale;

    const indexCurlRatio = dist(indexTip, indexMcp) / handScale;
    const thumbExtensionRatio = dist(thumbTip, thumbMcp) / handScale;

    const middleExt = dist(middleTip, middleMcp) / handScale;
    const ringExt = dist(ringTip, ringMcp) / handScale;
    const pinkyExt = dist(pinkyTip, pinkyMcp) / handScale;

    const circleCenter = {
      x: (thumbTip.x + indexTip.x) / 2,
      y: (thumbTip.y + indexTip.y) / 2,
    };

    const middleAwayFromCircle = dist(middleTip, circleCenter) / handScale;
    const ringAwayFromCircle = dist(ringTip, circleCenter) / handScale;
    const pinkyAwayFromCircle = dist(pinkyTip, circleCenter) / handScale;
    const awayAvg =
      (middleAwayFromCircle + ringAwayFromCircle + pinkyAwayFromCircle) / 3;

    // Orientation-tolerant extension check:
    // a finger is considered "open" when tip is farther from wrist than its PIP.
    const isMiddleOpen = dist(middleTip, wrist) > dist(middlePip, wrist) * 1.08;
    const isRingOpen = dist(ringTip, wrist) > dist(ringPip, wrist) * 1.08;
    const isPinkyOpen = dist(pinkyTip, wrist) > dist(pinkyPip, wrist) * 1.08;
    const openCount = Number(isMiddleOpen) + Number(isRingOpen) + Number(isPinkyOpen);

    const avgTipToWrist =
      (dist(middleTip, wrist) + dist(ringTip, wrist) + dist(pinkyTip, wrist)) / 3;
    const notFistLike = avgTipToWrist / handScale > FIST_GUARD_MIN;
    const threeFingersAvgExt = (middleExt + ringExt + pinkyExt) / 3;

    // Strict OK sign
    const strictOk =
      touchRatio < OK_TOUCH_THRESHOLD &&
      indexCurlRatio > INDEX_CURLED_MIN &&
      indexCurlRatio < INDEX_CURLED_MAX &&
      thumbExtensionRatio > THUMB_EXTENSION_MIN &&
      openCount >= 2 &&
      awayAvg > THREE_FINGERS_TO_CIRCLE_MIN &&
      notFistLike;

    // Moderate OK sign fallback (still rejects pinch/fist):
    // - touch must be close
    // - middle+ring+pinky should generally be farther from wrist than index
    // - not fist-like
    const moderateOk =
      touchRatio < OK_TOUCH_THRESHOLD * 1.08 &&
      thumbExtensionRatio > THUMB_EXTENSION_MIN * 0.9 &&
      threeFingersAvgExt > indexCurlRatio + 0.1 &&
      (threeFingersAvgExt > 0.9 || openCount >= 2) &&
      awayAvg > THREE_FINGERS_TO_CIRCLE_MIN * 0.9 &&
      notFistLike;

    return strictOk || moderateOk;
  }

  function labelHandsLeftRight(predictions) {
    const hands = (predictions || [])
      .map((pred) => {
        const wrist = pred?.keypoints?.[0];
        return { pred, wristX: wrist?.x ?? Number.POSITIVE_INFINITY };
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

  function maybeEmitVideoRect() {
    if (!onVideoRectChange) return;

    const videoEl = videoRef.current;
    if (!videoEl) return;

    const rect = videoEl.getBoundingClientRect();
    const videoW = Math.max(1, videoSizeRef.current.width);
    const videoH = Math.max(1, videoSizeRef.current.height);
    const fit = window.getComputedStyle(videoEl).objectFit || "cover";
    const scale =
      fit === "contain"
        ? Math.min(rect.width / videoW, rect.height / videoH)
        : Math.max(rect.width / videoW, rect.height / videoH);

    const drawW = videoW * scale;
    const drawH = videoH * scale;
    const offsetX = (rect.width - drawW) / 2;
    const offsetY = (rect.height - drawH) / 2;

    const next = {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      right: rect.left + offsetX + drawW,
      bottom: rect.top + offsetY + drawH,
      width: drawW,
      height: drawH,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };

    const prev = lastVideoRectRef.current;
    const changed =
      !prev ||
      Math.abs(prev.left - next.left) > 1 ||
      Math.abs(prev.top - next.top) > 1 ||
      Math.abs(prev.right - next.right) > 1 ||
      Math.abs(prev.bottom - next.bottom) > 1 ||
      Math.abs(prev.width - next.width) > 1 ||
      Math.abs(prev.height - next.height) > 1 ||
      prev.viewportWidth !== next.viewportWidth ||
      prev.viewportHeight !== next.viewportHeight;

    if (changed) {
      lastVideoRectRef.current = next;
      onVideoRectChange(next);
    }
  }

  function drawHand(ctx, pred, isPinching) {
    const kp = pred?.keypoints;
    if (!kp || kp.length < 21) return;

    // skeleton
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

    // points
    for (const p of kp) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(106,166,255,0.9)";
      ctx.fill();
    }

    // thumb-index line
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
  }

  function drawOverlay() {
    const canvas = overlayRef.current;
    const ctx = canvas.getContext("2d");

    const videoW = Math.max(1, videoSizeRef.current.width);
    const videoH = Math.max(1, videoSizeRef.current.height);
    if (canvas.width !== videoW || canvas.height !== videoH) {
      canvas.width = videoW;
      canvas.height = videoH;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    maybeEmitVideoRect();

    const lr = lrPredRef.current;
    const pinchBySide = pinchRef.current;

    if (lr.left) drawHand(ctx, lr.left, pinchBySide.left);
    if (lr.right) drawHand(ctx, lr.right, pinchBySide.right);
  }

  async function loop() {
    const detector = detectorRef.current;
    const video = videoRef.current;

    // always draw at display rate (smooth UI),
    // but throttle model inference (smooth performance)
    if (detector && video && video.readyState >= 2) {
      const now = performance.now();
      const shouldInfer = now - lastInferAtRef.current >= INFERENCE_INTERVAL_MS;

      if (shouldInfer) {
        lastInferAtRef.current = now;

        const predictions = await detector.estimateHands(video, {
          // Mirror is handled in CSS on both video + overlay for consistent
          // mobile behavior. Keep model coordinates in source space.
          flipHorizontal: false,
        });

        const lr = labelHandsLeftRight(predictions);
        lrPredRef.current = lr;

        const nextPinch = {
          left: lr.left ? computePinch(lr.left) : false,
          right: lr.right ? computePinch(lr.right) : false,
        };
        pinchRef.current = nextPinch;

        // capture trigger (edge + cooldown + no countdown)
        const nowMs = Date.now();
        const cooledDown = nowMs - lastCaptureAtRef.current > COOLDOWN_MS;

        const tryTrigger = (side) => {
          const isPinchNow = nextPinch[side];
          const armed = pinchArmedRef.current[side];

          if (!isPinchNow) {
            pinchArmedRef.current[side] = true;
            return;
          }

          if (
            isPinchNow &&
            armed &&
            cooledDown &&
            !countdownActiveRef.current
          ) {
            lastCaptureAtRef.current = nowMs;
            pinchArmedRef.current[side] = false;
            startCountdownAndCapture();
          }
        };

        tryTrigger("left");
        tryTrigger("right");

      }
    }

    // draw every frame using last predictions
    if (overlayRef.current) drawOverlay();

    rafRef.current = requestAnimationFrame(loop);
  }

  async function startTracking() {
    if (startedRef.current || stoppedRef.current || isStarting) return;
    setIsStarting(true);
    setStartError("");

    try {
      await setupCamera();
      if (stoppedRef.current) return;

      await setupModel();
      if (stoppedRef.current) return;

      startedRef.current = true;
      setShowStartGate(false);
      setStatus("Tracking... make an OK sign (either hand) to start 3s timer");
      rafRef.current = requestAnimationFrame(loop);
    } catch (e) {
      console.error(e);
      startedRef.current = false;
      setShowStartGate(true);
      const errName = e?.name ? String(e.name) : "UnknownError";
      const errMsg = e?.message ? String(e.message) : "Could not access camera.";
      setStartError(`${errName}: ${errMsg}`);
      setStatus(
        "Error: camera/model failed. Check permissions + HTTPS (or localhost)."
      );
    } finally {
      setIsStarting(false);
    }
  }

  useEffect(() => {
    if (!supportsMedia) {
      setStatus("Camera not supported in this browser.");
      return;
    }

    stoppedRef.current = false;

    return () => {
      stoppedRef.current = true;
      startedRef.current = false;
      setShowStartGate(true);
      setIsStarting(false);

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

  useEffect(() => {
    if (!supportsMedia) return;

    let timerId = null;
    const refreshForViewport = () => {
      if (!startedRef.current) return;
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => {
        if (isMobileDevice) {
          reconfigureCameraForViewport();
        } else {
          applyViewportConstraintsToActiveTrack();
        }
      }, 120);
    };

    window.addEventListener("resize", refreshForViewport);
    window.addEventListener("orientationchange", refreshForViewport);

    return () => {
      if (timerId) clearTimeout(timerId);
      window.removeEventListener("resize", refreshForViewport);
      window.removeEventListener("orientationchange", refreshForViewport);
    };
  }, [supportsMedia, isMobileDevice]);

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

        {showStartGate && (
          <div className="ct-startGate">
            <div className="ct-startIntro">
              <h1 className="ct-startTitle">Hand-Tracking Camera</h1>
              <p className="ct-startText">
                Tap <strong>Enable Camera</strong> to begin. Once the camera is
                active, make an <strong>OK sign</strong> (thumb and index
                touching, other three fingers extended) to start the countdown
                and capture a photo. Captured photos appear in the gallery,
                where you can view and download them.
              </p>
            </div>
            <button
              className="ct-startBtn"
              onClick={startTracking}
              disabled={isStarting || !supportsMedia}
              type="button"
            >
              {isStarting ? "Starting camera..." : "Enable Camera"}
            </button>
            {!isSecureContext && (
              <div className="ct-startMsg">
                Camera requires HTTPS (or localhost).
              </div>
            )}
            {startError && <div className="ct-startErr">{startError}</div>}
          </div>
        )}
      </div>

      <canvas ref={captureCanvasRef} className="ct-hiddenCanvas" />
    </div>
  );
}

