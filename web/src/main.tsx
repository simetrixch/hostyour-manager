import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./ds/tokens.css";
import "./ds/shell.css";
import "./ds/ui.css";
import "./ds/screens.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
