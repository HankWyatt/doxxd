import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UnknownValue, orUnknown } from "./unknown-value";

afterEach(cleanup);

describe("UnknownValue", () => {
  it("shows nothing visually, labels itself Unknown, and defaults the title", () => {
    const { container } = render(<UnknownValue />);
    const label = screen.getByText("Unknown");
    expect(label.className).toBe("sr-only");
    expect(container.textContent).toBe("Unknown");
    expect(label.parentElement?.getAttribute("title")).toBe("Not available");
    expect(container.textContent).not.toMatch(/\$|—/);
  });

  it("carries a supplied reason as the title", () => {
    render(<UnknownValue reason="Not priced yet" />);
    expect(screen.getByText("Unknown").parentElement?.getAttribute("title")).toBe("Not priced yet");
  });
});

describe("orUnknown", () => {
  it("passes text through and turns null into the unknown marker", () => {
    const { container } = render(<>{orUnknown("$0.00")}</>);
    expect(container.textContent).toBe("$0.00");
    cleanup();
    render(<>{orUnknown(null, "Value unavailable")}</>);
    expect(screen.getByText("Unknown").parentElement?.getAttribute("title")).toBe("Value unavailable");
  });
});
