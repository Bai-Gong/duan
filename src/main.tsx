import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri } from "@tauri-apps/api/core";
import { initializeGlassTheme } from "@baigong/fang/glass";
import "@baigong/fang/glass.css";
import "./styles/global.css";

initializeGlassTheme(isTauri());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
