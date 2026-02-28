import { useEffect, useMemo, useState } from "react";
import "./App.css";
import CameraTracking from "./cameratracking";

export default function App() {
  const [photos, setPhotos] = useState([]);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [videoRect, setVideoRect] = useState(null);

  function addPhoto(dataUrl) {
    setPhotos((prev) => [dataUrl, ...prev].slice(0, 50));
    setActiveIndex(0);
  }

  const latest = photos[0] ?? null;

  function openGallery(index = 0) {
    if (!photos.length) return;
    setActiveIndex(index);
    setGalleryOpen(true);
  }

  function closeGallery() {
    setGalleryOpen(false);
  }

  const activePhoto = useMemo(() => photos[activeIndex], [photos, activeIndex]);
  const latestWrapStyle = useMemo(() => {
    if (!videoRect) return undefined;

    const margin = 10;
    const rightInset = Math.max(
      margin,
      videoRect.viewportWidth - videoRect.right + margin
    );
    const bottomInset = Math.max(
      margin,
      videoRect.viewportHeight - videoRect.bottom + margin
    );

    return {
      left: "auto",
      right: `${rightInset}px`,
      bottom: `${bottomInset}px`,
    };
  }, [videoRect]);

  // Keyboard controls while gallery is open
  useEffect(() => {
    if (!galleryOpen) return;

    function onKeyDown(e) {
      if (e.key === "Escape") closeGallery();
      if (e.key === "ArrowRight") {
        setActiveIndex((i) => (i + 1) % photos.length);
      }
      if (e.key === "ArrowLeft") {
        setActiveIndex((i) => (i - 1 + photos.length) % photos.length);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [galleryOpen, photos.length]);

  function deleteActive() {
    setPhotos((prev) => {
      const next = prev.filter((_, idx) => idx !== activeIndex);
      const newIndex = Math.max(0, Math.min(activeIndex, next.length - 1));
      setActiveIndex(newIndex);
      if (next.length === 0) setGalleryOpen(false);
      return next;
    });
  }

  function downloadActive() {
    if (!activePhoto) return;
    const a = document.createElement("a");
    a.href = activePhoto;
    a.download = `pinchcam-${Date.now()}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="page">
      <div className="cameraStage">
        <CameraTracking onCapture={addPhoto} onVideoRectChange={setVideoRect} />
      </div>

      <div className="latestWrap" style={latestWrapStyle}>
        {latest ? (
          <button
            className="latestBtn"
            onClick={() => openGallery(0)}
            title="Open gallery"
          >
            <img src={latest} alt="latest" />
            <div className="latestMeta">
              <span>Gallery</span>
              <span className="count">{photos.length}</span>
            </div>
          </button>
        ) : (
          <div className="latestPlaceholder">
            <div className="phTitle">No photos yet</div>
            <div className="phSub">Make an OK sign to capture</div>
          </div>
        )}
      </div>

      {/* Gallery modal */}
      {galleryOpen && activePhoto && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modalBackdrop" onClick={closeGallery} />

          <div className="modalContent">
            <div className="modalTop">
              <div className="modalTitle">
                {activeIndex + 1} / {photos.length}
              </div>

              <div className="modalActions">
                <button
                  className="iconBtn"
                  onClick={downloadActive}
                  title="Download"
                >
                  Download
                </button>
                <button className="iconBtn" onClick={deleteActive} title="Delete">
                  Delete
                </button>
                <button className="iconBtn" onClick={closeGallery} title="Close">
                  Close
                </button>
              </div>
            </div>

            <div className="modalBody">
              <button
                className="navBtn"
                onClick={() =>
                  setActiveIndex((i) => (i - 1 + photos.length) % photos.length)
                }
                aria-label="Previous"
              >
                {"<"}
              </button>

              <div className="modalImageWrap">
                <img className="modalImage" src={activePhoto} alt="active" />
              </div>

              <button
                className="navBtn"
                onClick={() => setActiveIndex((i) => (i + 1) % photos.length)}
                aria-label="Next"
              >
                {">"}
              </button>
            </div>

            <div className="strip">
              {photos.map((p, idx) => (
                <button
                  key={idx}
                  className={"stripThumb " + (idx === activeIndex ? "active" : "")}
                  onClick={() => setActiveIndex(idx)}
                  title={`Photo ${idx + 1}`}
                >
                  <img src={p} alt={`strip-${idx}`} />
                </button>
              ))}
            </div>

            <div className="modalFoot">
              <span>Tip: Use Left/Right arrows to navigate, Esc to close.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

