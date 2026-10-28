import { render, screen, fireEvent, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SaveWalletButton, WatchlistManager } from "./watchlist";
import type { WatchlistError } from "@/lib/watchlist";
const { state, add, rename, remove, reload } = vi.hoisted(() => ({
  state: { ready: true, wallets: [] as {address:string;label:string}[], error: null as WatchlistError | null },
  add: vi.fn(), rename: vi.fn(), remove: vi.fn(), reload: vi.fn(),
}));
vi.mock("@/lib/use-watchlist", () => ({useWatchlist: () => ({...state, add, rename, remove, reload})}));
const address = "11111111111111111111111111111111";
beforeEach(() => {
  state.ready = true; state.wallets = []; state.error = null;
  for (const fn of [add,rename,remove,reload]) fn.mockReset();
  add.mockReturnValue({ok:true}); rename.mockReturnValue({ok:true}); remove.mockReturnValue({ok:true});
});
it("disables server-rendered save and add controls before storage is read", () => {
  state.ready = false;
  const markup = renderToString(<><SaveWalletButton address={address}/><WatchlistManager/></>);
  const dom = new DOMParser().parseFromString(markup, "text/html");
  expect([...dom.querySelectorAll("input,button")].every(el => el.hasAttribute("disabled"))).toBe(true);
});
it("submits an address and optional label without navigating or querying wallet data", () => {
  render(<WatchlistManager/>);
  fireEvent.change(screen.getByLabelText("Solana wallet address"),{target:{value:address}});
  fireEvent.change(screen.getByLabelText(/Label/),{target:{value:"Treasury"}});
  fireEvent.click(screen.getByRole("button",{name:"Save wallet"}));
  expect(add).toHaveBeenCalledWith(address,"Treasury");
  expect(screen.getByRole("status")).toHaveTextContent("Wallet saved.");
  expect(screen.getByLabelText("Solana wallet address")).toHaveValue("");
});
it("preserves user input and reports a failed save without success feedback", () => {
  add.mockReturnValue({ok:false,reason:"storage_unavailable"});
  render(<WatchlistManager/>);
  fireEvent.change(screen.getByLabelText("Solana wallet address"),{target:{value:address}});
  fireEvent.click(screen.getByRole("button",{name:"Save wallet"}));
  expect(screen.getByRole("alert")).toHaveTextContent("Browser storage could not be used");
  expect(screen.getByLabelText("Solana wallet address")).toHaveValue(address);
  expect(screen.queryByText("Wallet saved.")).not.toBeInTheDocument();
});
it("keeps unreadable data read-only and offers an explicit reload", () => {
  state.error = "unsupported_version";
  render(<WatchlistManager/>);
  expect(screen.getByRole("alert")).toHaveTextContent("left untouched");
  expect(screen.getByRole("button",{name:"Save wallet"})).toBeDisabled();
  fireEvent.submit(screen.getByRole("form",{name:"Save a wallet"}));
  expect(add).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Try again"}));
  expect(reload).toHaveBeenCalledOnce();
});
it("opens the exact public wallet routes and saves a user label", () => {
  state.wallets = [{address,label:"Treasury"}];
  render(<WatchlistManager/>);
  const row = screen.getByRole("listitem");
  expect(within(row).getByRole("link",{name:/Portfolio/})).toHaveAttribute("href","/wallet/"+address);
  expect(within(row).getByRole("link",{name:/Activity/})).toHaveAttribute("href","/wallet/"+address+"/activity");
  fireEvent.click(within(row).getByRole("button",{name:"Edit label for "+address}));
  fireEvent.change(within(row).getByLabelText("Label"),{target:{value:"Long-term wallet"}});
  fireEvent.click(within(row).getByRole("button",{name:"Save label"}));
  expect(rename).toHaveBeenCalledWith(address,"Long-term wallet");
  fireEvent.click(within(row).getByRole("button",{name:"Remove "+address}));
  expect(remove).toHaveBeenCalledWith(address);
});
it("uses an explicit pressed state for saved public wallets", () => {
  state.wallets = [{address,label:""}];
  render(<SaveWalletButton address={address}/>);
  const button = screen.getByRole("button",{name:"Remove wallet from watchlist"});
  expect(button).toHaveAttribute("aria-pressed","true");
  fireEvent.click(button);
  expect(remove).toHaveBeenCalledWith(address);
});

it.each(["add", "edit"])("accepts Unicode labels by code point in the %s form", async (mode) => {
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup();
  const label = "🙂".repeat(41);
  if (mode === "edit") state.wallets = [{address,label:""}];
  render(<WatchlistManager/>);
  if (mode === "edit") {
    await user.click(screen.getByRole("button",{name:"Edit label for "+address}));
    await user.type(screen.getByLabelText("Label",{exact:true}),label);
    await user.click(screen.getByRole("button",{name:"Save label"}));
    expect(rename).toHaveBeenCalledWith(address,label);
  } else {
    await user.type(screen.getByLabelText("Solana wallet address"),address);
    await user.type(screen.getByLabelText(/Label/),label);
    await user.click(screen.getByRole("button",{name:"Save wallet"}));
    expect(add).toHaveBeenCalledWith(address,label);
  }
});
