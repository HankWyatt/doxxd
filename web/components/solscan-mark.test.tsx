import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SolscanMark } from "./solscan-mark";

describe("SolscanMark", () => {
  it("renders the decorative Solscan logo and leaves the link name to its parent", () => {
    render(
      <a href="https://solscan.io/tx/x" aria-label="View transaction on Solscan">
        <SolscanMark />
      </a>,
    );
    const link = screen.getByRole("link", { name: "View transaction on Solscan" });
    const img = link.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/brands/solscan.svg");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("width", "14");
    expect(img).toHaveAttribute("height", "14");
  });
});
