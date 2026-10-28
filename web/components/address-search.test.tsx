import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AddressSearch } from "./address-search";
import { renderToString } from "react-dom/server";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
beforeEach(() => push.mockClear());
it("keeps the server-rendered form disabled until navigation handlers hydrate", () => {
  const markup = renderToString(<AddressSearch />);
  const dom = new DOMParser().parseFromString(markup, "text/html");
  expect(dom.querySelector("input")?.hasAttribute("disabled")).toBe(true);
  expect(dom.querySelector("button")?.hasAttribute("disabled")).toBe(true);
});
it("rejects malformed input without initiating navigation", () => {
  render(<AddressSearch />);
  fireEvent.change(screen.getByRole("textbox", { name: /solana address/i }), {
    target: { value: "not-a-wallet" },
  });
  fireEvent.submit(screen.getByRole("search"));
  expect(screen.getByRole("alert")).toHaveTextContent(/valid Solana address/i);
  expect(push).not.toHaveBeenCalled();
});
it("opens the same public portfolio route for any valid address", () => {
  render(<AddressSearch />);
  fireEvent.change(screen.getByRole("textbox", { name: /solana address/i }), {
    target: { value: " 11111111111111111111111111111111 " },
  });
  fireEvent.submit(screen.getByRole("search"));
  expect(push).toHaveBeenCalledWith("/wallet/11111111111111111111111111111111");
});
