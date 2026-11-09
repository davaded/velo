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

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            backgroundColor: "#181B1A",
            color: "#fafafa",
            fontFamily: "monospace",
            height: "100vh",
          }}
        >
          <h3 style={{ color: "#f7796d", marginBottom: 8 }}>UI Render Error</h3>
          <pre style={{ color: "#A1A5A4", whiteSpace: "pre-wrap" }}>
            {this.state.error.message}
          </pre>
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
