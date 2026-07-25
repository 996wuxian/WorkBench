import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, loadTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/tailwind.css";
import "./styles/app.css";

// Apply theme before first paint to avoid flash + enable CSS transitions later.
applyTheme(loadTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
