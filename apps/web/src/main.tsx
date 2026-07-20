import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import { createAppRoutes } from "./app";
import "@tabletop/ui/styles.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={createBrowserRouter(createAppRoutes())} />
  </StrictMode>,
);
