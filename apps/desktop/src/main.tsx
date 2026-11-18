import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./ui/ui.css";
import "./features/features.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root ausente");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
