import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GITHUB_URL } from "./home/constants";
import { SiteFooter } from "./site-footer";

describe("SiteFooter", () => {
  it("carries the tagline, the GitHub source link and DMND", () => {
    const { container } = render(<SiteFooter />);
    expect(screen.getByText("Public wallets. Open possibilities.")).toBeInTheDocument();
    const github = screen.getByRole("link", { name: "Open source on GitHub" });
    expect(github).toHaveAttribute("href", GITHUB_URL);
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Powered by DMND" })).toHaveAttribute("href", "https://dmnd.dev");
    expect(container).not.toHaveTextContent("Read-only explorer");
  });
});
