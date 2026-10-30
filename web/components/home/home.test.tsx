import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";
import { ActionsAvailabilityProvider } from "@/lib/actions/availability";
import { resources } from "@/lib/dmnd/resources";
import { WalletConnectProvider } from "../wallet-connect/provider";
import { GITHUB_URL, HOME_PROTOCOLS, TRY_WHALE_ADDRESS } from "./constants";
import { PREVIEW_ADDRESS } from "./portfolio-preview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderHome(enabled: boolean) {
  return render(
    <ActionsAvailabilityProvider enabled={enabled}>
      <WalletConnectProvider>
        <HomePage />
      </WalletConnectProvider>
    </ActionsAvailabilityProvider>,
  );
}

describe("homepage", () => {
  it("leads with the headline, the tracker pitch and the whale shortcut", () => {
    renderHome(false);
    expect(screen.getByRole("heading", { level: 1, name: /^Every wallet\.\s*In plain sight\.$/ })).toBeInTheDocument();
    expect(
      screen.getByText(
        "The portfolio tracker for Solana. See what any wallet holds, from tokens to staking, lending and liquidity, and follow the ones that matter to you.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/No wallet needed to look\. Not sure where to start\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try a whale" })).toHaveAttribute(
      "href",
      `/wallet/${TRY_WHALE_ADDRESS}`,
    );
    expect(screen.getByRole("textbox", { name: "Solana address" })).toBeInTheDocument();
    // A real space before the link, so it is not read as "start?Try a whale".
    expect(screen.getByRole("link", { name: "Try a whale" }).parentElement).toHaveTextContent(
      "Not sure where to start? Try a whale",
      { normalizeWhitespace: false },
    );
  });

  it("previews only what the product shows: no invented daily change, a legend-sized protocol count", () => {
    const { container } = renderHome(false);
    expect(container).not.toHaveTextContent(/today/i);
    expect(screen.getByRole("img", { name: /^Example portfolio/ })).toHaveTextContent("5 protocols");
    expect(container.querySelectorAll(".pf-legend > div")).toHaveLength(5);
  });

  it("drops the old explorer chrome", () => {
    const { container } = renderHome(false);
    for (const gone of ["01 / EXPLORE", "SOL / 001", "READ ONLY", "A LITTLE MORE TRANSPARENCY"])
      expect(container).not.toHaveTextContent(gone);
  });

  it("labels the hero card as an example with a synthetic address, not the whale", () => {
    renderHome(false);
    const card = screen.getByRole("img", { name: /^Example portfolio with made-up numbers/ });
    expect(card).toHaveTextContent(PREVIEW_ADDRESS);
    expect(card).not.toHaveTextContent(TRY_WHALE_ADDRESS.slice(0, 4));
  });

  it("lists the protocols in order", () => {
    renderHome(false);
    const strip = screen.getByRole("region", { name: "Supported protocols" });
    expect(strip).toHaveTextContent("Positions from");
    expect(within(strip).getAllByRole("listitem").map((li) => li.textContent)).toEqual([...HOME_PROTOCOLS]);
  });

  it("names only protocols Doxxd reads", () => {
    const labels = Object.values(resources).map((r) => r.label);
    for (const name of HOME_PROTOCOLS)
      expect(labels.some((label) => label.startsWith(name)), name).toBe(true);
  });

  it("links the watchlist pillar and the GitHub footer", () => {
    renderHome(false);
    expect(screen.getByRole("heading", { name: "Track any wallet" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "See inside every position" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open your watchlist" })).toHaveAttribute("href", "/watchlist");
    const github = screen.getByRole("link", { name: "Open source on GitHub" });
    expect(github).toHaveAttribute("href", GITHUB_URL);
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    expect(github).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Public wallets. Open possibilities.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Powered by DMND" })).toBeInTheDocument();
  });

  it("with actions off, the third pillar promises no claim or withdraw", () => {
    const { container } = renderHome(false);
    expect(screen.getByRole("heading", { name: "Your own wallet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Manage your own" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/claim|withdraw/i);
  });

  it("with actions on, the third pillar offers the connect flow", async () => {
    renderHome(true);
    expect(screen.getByRole("heading", { name: "Manage your own" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Connect your wallet to claim LP fees and withdraw from Meteora and Raydium pools right here. Your wallet signs; Doxxd never holds your keys.",
      ),
    ).toBeInTheDocument();
    const pillar = screen.getByRole("article", { name: "Manage your own" });
    expect(await within(pillar).findByRole("button", { name: "Connect wallet" })).toBeEnabled();
  });
});
