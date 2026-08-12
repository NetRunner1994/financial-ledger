import React from "react";
import { createRoot } from "react-dom/client";
import { installStorage } from "./storage.js";
import Ledger from "./Ledger.jsx";
import "./index.css";

// Must run before the app mounts: Ledger reads window.storage on first render.
installStorage();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Ledger />
  </React.StrictMode>
);
