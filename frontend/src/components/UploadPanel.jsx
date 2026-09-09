import { useRef, useState } from "react";

// Uploading a video directly, rather than waiting for the watched channel to
// publish one. The file goes straight to the backend as the request body and
// then through the same clip pipeline.

const MB = 1024 * 1024;

function formatSize(bytes) {
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function UploadPanel({ onUpload, disabled, disabledReason }) {
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  const uploading = progress !== null;

  function chooseFile(nextFile) {
    if (!nextFile) return;
    setError(null);
    setFile(nextFile);
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    if (disabled || uploading) return;
    chooseFile(event.dataTransfer?.files?.[0]);
  }

  async function startUpload() {
    if (!file || uploading) return;
    setError(null);
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await onUpload(file, {
        onProgress: setProgress,
        signal: controller.signal,
      });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (uploadError) {
      // Cancelling is a deliberate act, not a failure to report back.
      if (uploadError.code !== "upload_cancelled") setError(uploadError.message);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }

  return (
    <section className="automation-card upload-card">
      <div className="upload-head">
        <h2>Upload a video</h2>
        <p className="upload-lede">
          Drop in an episode and Ravi will clip it, then post to every connected account.
        </p>
      </div>

      <div
        className={`upload-drop ${dragging ? "dragging" : ""} ${disabled ? "disabled" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="upload-input"
          id="ravi-upload-input"
          disabled={disabled || uploading}
          onChange={(event) => chooseFile(event.target.files?.[0])}
        />
        <label htmlFor="ravi-upload-input" className="upload-label">
          {file ? (
            <>
              <span className="upload-filename">{file.name}</span>
              <span className="upload-filesize">{formatSize(file.size)}</span>
            </>
          ) : (
            <>
              <span className="upload-filename">Choose a video or drag one here</span>
              <span className="upload-filesize">MP4, MOV, MKV or WebM · up to 500 MB</span>
            </>
          )}
        </label>
      </div>

      {uploading && (
        <div className="upload-progress">
          <div className="upload-progress-track">
            <div className="upload-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="upload-progress-label">
            {progress < 100 ? `Uploading ${progress}%` : "Processing…"}
          </span>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      {disabled && disabledReason && <p className="upload-note">{disabledReason}</p>}

      <div className="upload-actions">
        {uploading ? (
          <button className="btn-quiet" onClick={() => abortRef.current?.abort()}>
            Cancel upload
          </button>
        ) : (
          <button className="btn-primary" disabled={!file || disabled} onClick={startUpload}>
            Make clips
          </button>
        )}
      </div>
    </section>
  );
}
