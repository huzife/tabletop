import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "./App";

describe("scene editor", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("renders the local editor workspace and coordinate contract", () => {
    render(<App />);

    expect(screen.getByText("Scene Draft")).toBeInTheDocument();
    expect(screen.getByLabelText("场景画布")).toBeInTheDocument();
    expect(screen.getByText("左上原点 · X → · Y ↓ · contain 等比缩放")).toBeInTheDocument();
    expect(screen.getByText("tabletop.scene/v1 · 0 个对象")).toBeInTheDocument();
  });

  it("switches tools and opens the image insertion workflow", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "矩形 (R)" }));
    expect(screen.getByText("矩形工具")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));
    expect(screen.getByRole("dialog", { name: "插入图片" })).toBeInTheDocument();
    expect(screen.getByText("资源链接会保存在场景描述文件中")).toBeInTheDocument();
  });
});
