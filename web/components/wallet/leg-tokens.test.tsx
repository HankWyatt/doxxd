import { render, screen, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProtocolSection } from "./protocol-section";
import { HoldingsTokens, type TokenMetaMap } from "./token-meta";
import { validResourcePayload } from "@/lib/dmnd/validation.server";
import type { ProtocolResource } from "@/lib/dmnd/contracts";
import { short } from "@/lib/portfolio/adapters/shared";
import {
  CLMM,
  CPMM,
  clmmPage,
  cpmmPage,
} from "@/tests/fixtures/synthetic-raydium-positions";

// Reserved example hosts only; no request leaves the test.
const IMAGE_A = "https://tokens.example.com/syna.png";
const IMAGE_B = "https://tokens.example.com/synb.png";
const WSOL = "So11111111111111111111111111111111111111112";

afterEach(() => vi.unstubAllGlobals());

function serve(resource: ProtocolResource, data: unknown) {
  expect(validResourcePayload(resource, data)).toBe(true);
  const fetch = vi.fn(async () => Response.json({ ok: true, data }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function card(
  resource: ProtocolResource,
  address: string,
  { labels = {}, tokens = {} }: { labels?: Record<string, string>; tokens?: TokenMetaMap } = {},
) {
  return render(
    <HoldingsTokens.Provider value={tokens}>
      <ProtocolSection
        address={address}
        resource={resource}
        mode={{ kind: "live" }}
        labels={labels}
        defaultOpen
      />
    </HoldingsTokens.Provider>,
  );
}
const pairIcons = (row: HTMLElement) =>
  Array.from(row.querySelectorAll(".pair-icons > .token-icon"));

it("names CPMM legs and shows their images from DMND's leg labels", async () => {
  const page = cpmmPage();
  Object.assign(page.data[0].principal[0], {
    symbol: " SYNA ",
    name: "Synthetic A",
    image_url: IMAGE_A,
  });
  serve("raydium-cpmm", page);
  card("raydium-cpmm", CPMM.wallet);
  const table = await screen.findByRole("table");
  const name = within(table).getByText("SYNA + " + short(CPMM.tokenB));
  // Symbols are creator-supplied: the mints stay reachable.
  expect(name).toHaveAttribute("title", CPMM.tokenA + " + " + CPMM.tokenB);
  const row = name.closest("tr")!;
  const [a, b] = pairIcons(row);
  expect(a.querySelector("img")).toHaveAttribute("src", IMAGE_A);
  expect(b.querySelector("img")).toBeNull();
  expect(b).toHaveTextContent(short(CPMM.tokenB).slice(0, 1));
  // The balance line carries the same image, the bare mint none.
  const balance = row.children[1] as HTMLElement;
  expect(balance.querySelectorAll("img")).toHaveLength(1);
  expect(within(balance).getByText("SYNA")).toHaveAttribute("title", CPMM.tokenA);
  fireEvent.click(within(row).getByRole("button", { name: /details/ }));
  const detail = document.querySelector(".detail-row") as HTMLElement;
  expect(within(detail).getAllByText(CPMM.tokenA).length).toBeGreaterThan(0);
});

it("falls back to the holdings symbol and image for legs DMND left unlabelled", async () => {
  serve("raydium-cpmm", cpmmPage());
  card("raydium-cpmm", CPMM.wallet, {
    labels: { [CPMM.tokenB]: "SYNB" },
    tokens: { [CPMM.tokenB]: { symbol: "SYNB", image: IMAGE_B } },
  });
  const table = await screen.findByRole("table");
  const row = within(table)
    .getByText(short(CPMM.tokenA) + " + SYNB")
    .closest("tr")!;
  const [a, b] = pairIcons(row);
  expect(a.querySelector("img")).toBeNull();
  expect(b.querySelector("img")).toHaveAttribute("src", IMAGE_B);
});

it("prefers DMND's leg labels over the holdings labels", async () => {
  const page = cpmmPage();
  Object.assign(page.data[0].principal[1], { symbol: "SYNB", image_url: IMAGE_B });
  serve("raydium-cpmm", page);
  card("raydium-cpmm", CPMM.wallet, {
    labels: { [CPMM.tokenB]: "OTHER" },
    tokens: { [CPMM.tokenB]: { symbol: "OTHER", image: IMAGE_A } },
  });
  const table = await screen.findByRole("table");
  const row = within(table)
    .getByText(short(CPMM.tokenA) + " + SYNB")
    .closest("tr")!;
  expect(pairIcons(row)[1].querySelector("img")).toHaveAttribute("src", IMAGE_B);
  expect(within(table).queryByText(/OTHER/)).toBeNull();
});

it("keeps the short mint and initials when no labels are known", async () => {
  serve("raydium-amm-v4", { ...cpmmPage(), protocol: "raydium_amm_v4" });
  card("raydium-amm-v4", CPMM.wallet);
  const table = await screen.findByRole("table");
  const row = within(table)
    .getByText(short(CPMM.tokenA) + " + " + short(CPMM.tokenB))
    .closest("tr")!;
  const icons = pairIcons(row);
  expect(icons.map((icon) => icon.textContent)).toEqual([
    short(CPMM.tokenA).slice(0, 1),
    short(CPMM.tokenB).slice(0, 1),
  ]);
  expect(row.querySelectorAll("img")).toHaveLength(0);
});

it("shows wrapped SOL as SOL with the SOL mark, whatever labels it carries", async () => {
  const page = cpmmPage();
  Object.assign(page.data[0].principal[1], {
    mint: WSOL,
    symbol: "WSOL",
    name: "Wrapped SOL",
    image_url: IMAGE_B,
  });
  serve("raydium-cpmm", page);
  card("raydium-cpmm", CPMM.wallet, {
    tokens: { [WSOL]: { symbol: "WSOL", image: IMAGE_A } },
  });
  const table = await screen.findByRole("table");
  const name = within(table).getByText(short(CPMM.tokenA) + " + SOL");
  const row = name.closest("tr")!;
  const sol = pairIcons(row)[1];
  expect(sol.querySelector("svg")).not.toBeNull();
  expect(sol.querySelector("img")).toBeNull();
  expect(within(row).queryByText(/WSOL/)).toBeNull();
  // The SOL mark sits beside the amount too; the mint stays on hover.
  expect(within(row.children[1] as HTMLElement).getByText("SOL")).toHaveAttribute("title", WSOL);
});

it("resolves IPFS leg images and refuses unsafe ones", async () => {
  const page = cpmmPage();
  page.data[0].principal[0].image_url = "ipfs://bafysyntheticcidforlegimages/a.png";
  page.data[0].principal[1].image_url = "http://tokens.example.com/b.png";
  page.data[0].principal[1].symbol = "SYNB";
  serve("raydium-cpmm", page);
  card("raydium-cpmm", CPMM.wallet);
  const table = await screen.findByRole("table");
  const row = within(table)
    .getByText(short(CPMM.tokenA) + " + SYNB")
    .closest("tr")!;
  const [a, b] = pairIcons(row);
  expect(a.querySelector("img")).toHaveAttribute(
    "src",
    "https://gateway.pinata.cloud/ipfs/bafysyntheticcidforlegimages/a.png",
  );
  expect(b.querySelector("img")).toBeNull();
  expect(b).toHaveTextContent("S");
});

it("labels rewards from DMND and keeps their mints in details", async () => {
  const page = clmmPage();
  page.data[0].rewards = [
    { mint: CLMM.reward, owed_atoms: "7000000", symbol: "SYNR", image_url: IMAGE_A },
    { mint: WSOL, owed_atoms: "5", symbol: "WSOL" },
  ];
  serve("raydium-clmm", page);
  card("raydium-clmm", CLMM.wallet);
  const table = await screen.findByRole("table");
  fireEvent.click(within(table).getByRole("button", { name: /details/ }));
  const detail = document.querySelector(".detail-row") as HTMLElement;
  const reward = within(detail).getByText("SYNR");
  expect(reward).toHaveAttribute("title", CLMM.reward);
  expect(reward.parentElement!.querySelector("img")).toHaveAttribute("src", IMAGE_A);
  expect(within(detail).getByText(CLMM.reward)).toBeInTheDocument();
  expect(within(detail).getByText("SOL")).toHaveAttribute("title", WSOL);
  expect(within(detail).queryByText("WSOL")).toBeNull();
});

it("falls back to the leg's initial when its image fails to load", async () => {
  const page = cpmmPage();
  Object.assign(page.data[0].principal[0], { symbol: "SYNA", image_url: IMAGE_A });
  serve("raydium-cpmm", page);
  card("raydium-cpmm", CPMM.wallet);
  const table = await screen.findByRole("table");
  const row = within(table)
    .getByText("SYNA + " + short(CPMM.tokenB))
    .closest("tr")!;
  const icon = pairIcons(row)[0];
  fireEvent.error(icon.querySelector("img")!);
  expect(icon.querySelector("img")).toBeNull();
  expect(icon).toHaveTextContent("S");
});
