import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { audio } from "../sidepanel/audioService";
import "../sidepanel/styles.css";

function PermissionApp() {
  const [status, setStatus] = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const requestMic = async () => {
    setStatus("requesting");
    setErrorMessage("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // Stop tracks immediately after acquiring permission
      stream.getTracks().forEach((track) => track.stop());

      setStatus("granted");
      audio.playEarcon("scan_complete");

      // Notify any listeners (e.g. side panel)
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" }).catch(() => {});
      }

      // Auto-close tab after brief success confirmation
      setTimeout(() => {
        window.close();
      }, 1800);
    } catch (err: any) {
      console.warn("Microphone permission error:", err);
      setStatus("denied");
      audio.playEarcon("error");
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setErrorMessage("Permission was denied by Chrome or macOS system settings.");
      } else {
        setErrorMessage(err?.message || "Failed to access microphone.");
      }
    }
  };

  useEffect(() => {
    // Attempt automatic request on tab load
    const timer = setTimeout(() => {
      void requestMic();
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        padding: "1.5rem",
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font)",
      }}
    >
      <main
        style={{
          background: "var(--surface)",
          border: "2px solid var(--border)",
          borderRadius: "12px",
          padding: "2.5rem 2rem",
          maxWidth: "540px",
          width: "100%",
          textAlign: "center",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
        }}
        aria-labelledby="perm-title"
      >
        <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }} aria-hidden="true">
          🎤
        </div>
        <h1 id="perm-title" style={{ margin: "0 0 1rem", fontSize: "1.75rem", color: "var(--accent)" }}>
          PageGuide Microphone Access
        </h1>

        <p style={{ color: "var(--muted)", lineHeight: 1.5, margin: "0 0 1.5rem", fontSize: "1.05rem" }}>
          Chrome requires extension microphone permissions to be granted in a regular tab.
          Once allowed, hands-free voice commands will work seamlessly in the PageGuide side panel.
        </p>

        {status === "idle" || status === "requesting" ? (
          <div>
            <p style={{ fontWeight: 600, color: "var(--focus)", marginBottom: "1rem" }}>
              {status === "requesting"
                ? "Waiting for you to click “Allow” in Chrome's permission prompt above…"
                : "Click below to trigger the permission prompt:"}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: "1.1rem", padding: "0.8rem 1.8rem" }}
              onClick={() => void requestMic()}
              disabled={status === "requesting"}
            >
              {status === "requesting" ? "Requesting…" : "Enable Microphone"}
            </button>
          </div>
        ) : null}

        {status === "granted" ? (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: "1.2rem",
              background: "#064e3b",
              color: "#a7f3d0",
              border: "1px solid #059669",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "1.1rem",
            }}
          >
            ✓ Microphone permission granted!
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.95rem", color: "#6ee7b7" }}>
              Closing this tab and returning to PageGuide…
            </p>
          </div>
        ) : null}

        {status === "denied" ? (
          <div
            role="alert"
            style={{
              padding: "1.2rem",
              background: "var(--danger-bg)",
              color: "var(--danger)",
              border: "1px solid var(--danger)",
              borderRadius: "8px",
              textAlign: "left",
            }}
          >
            <p style={{ margin: "0 0 0.75rem", fontWeight: 700, fontSize: "1.05rem" }}>
              Microphone access could not be granted
            </p>
            <p style={{ margin: "0 0 1rem", fontSize: "0.95rem" }}>{errorMessage}</p>

            <div style={{ background: "#141c24", padding: "1rem", borderRadius: "6px", fontSize: "0.9rem" }}>
              <strong>How to unblock in Chrome & macOS:</strong>
              <ol style={{ margin: "0.5rem 0 0 1.25rem", padding: 0, lineHeight: 1.6 }}>
                <li>
                  Click the <strong>tune/sliders icon</strong> or <strong>lock icon</strong> in Chrome's address bar
                  above (next to <code>chrome-extension://</code>) and toggle <strong>Microphone</strong> to{" "}
                  <strong>Allow</strong>.
                </li>
                <li>
                  <strong>macOS users:</strong> Open <strong>System Settings → Privacy & Security → Microphone</strong>{" "}
                  and make sure <strong>Google Chrome</strong> is turned <strong>ON</strong>.
                </li>
              </ol>
            </div>

            <div style={{ textAlign: "center", marginTop: "1.25rem" }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void requestMic()}
                style={{ padding: "0.65rem 1.5rem" }}
              >
                Try Again
              </button>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<PermissionApp />);
}
