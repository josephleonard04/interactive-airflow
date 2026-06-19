import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installSceneApi } from "./scene/sceneApi";
import "./styles.css";

// Expose window.airflow for console / script / intent-layer control.
installSceneApi();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
