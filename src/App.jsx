import { useState } from "react";
import "./App.css";
import CameraTracking from "./cameratracking";

export default function App() {
  const [lastPhoto, setLastPhoto] = useState(null);
  const [photos, setPhotos] = useState([]);

  function handleCapture(dataUrl) {
    setLastPhoto(dataUrl);
    setPhotos((prev) => [dataUrl, ...prev].slice(0, 12));
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Pinch → Photo</h1>
          <p className="sub">
            Pinch your thumb + index finger to take a picture.
          </p>
        </div>
      </header>

      <main className="main">
        <section className="card">
          <CameraTracking onCapture={handleCapture} />
        </section>

        <section className="card">
          <div className="galleryHeader">
            <h2>Captured</h2>
            <span className="hint">{photos.length} photo(s)</span>
          </div>

          {lastPhoto ? (
            <div className="previewWrap">
              <img className="preview" src={lastPhoto} alt="Latest capture" />
            </div>
          ) : (
            <div className="empty">No photo yet. Try pinching.</div>
          )}

          {photos.length > 0 && (
            <div className="grid">
              {photos.map((p, idx) => (
                <button
                  key={idx}
                  className="thumbBtn"
                  onClick={() => setLastPhoto(p)}
                  title="Set as preview"
                >
                  <img className="thumb" src={p} alt={`capture-${idx}`} />
                </button>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <span>
          Tip: good lighting + keep hand in frame. If it’s too sensitive, tweak
          the pinch threshold in <code>CameraTracking.jsx</code>.
        </span>
      </footer>
    </div>
  );
}