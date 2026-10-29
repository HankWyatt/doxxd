import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ResourceState } from "./resource-state";

it("does not promise other sections for a wallet the connection turned away", () => {
  render(
    <ResourceState error={{ ok: false, kind: "not_enabled", scope: "wallet" }} />,
  );
  expect(screen.getByText("This wallet isn’t enabled yet")).toBeVisible();
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "Other wallet sections remain available",
  );
});

it("keeps the per-source copy for a source that is not enabled", () => {
  render(<ResourceState error={{ ok: false, kind: "not_enabled" }} />);
  expect(screen.getByText("Not available yet")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Other wallet sections remain available",
  );
});
