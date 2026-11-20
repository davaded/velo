import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  private handleResetCacheAndReload = () => {
    try {
      window.localStorage.removeItem("velo.events.v4");
      window.localStorage.removeItem("velo.events.v3");
      window.localStorage.removeItem("velo.events.v2");
      window.localStorage.removeItem("velo.events.v1");
    } catch {
      // ignore
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 28,
            backgroundColor: "#181B1A",
            color: "#fafafa",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            height: "100vh",
            boxSizing: "border-box",
          }}
        >
          <h3 style={{ color: "#f7796d", marginBottom: 10 }}>UI Render Error</h3>
          <pre style={{ color: "#A1A5A4", whiteSpace: "pre-wrap", marginBottom: 18 }}>
            {this.state.error.message}
          </pre>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={this.handleResetCacheAndReload}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                backgroundColor: "#8b5cf6",
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              清理本地缓存并重新加载
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid #3f3f46",
                backgroundColor: "transparent",
                color: "#e4e4e7",
                cursor: "pointer",
              }}
            >
              仅重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
