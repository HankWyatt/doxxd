import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { actionsEnabledFromEnv } from "./enabled";
import {
  ActionsAvailabilityProvider,
  useActionsEnabled,
} from "./availability";

describe("actionsEnabledFromEnv", () => {
  it("is true only for the exact value 1", () => {
    expect(actionsEnabledFromEnv({ DOXXD_ACTIONS_ENABLED: "1" })).toBe(true);
    expect(actionsEnabledFromEnv({ DOXXD_ACTIONS_ENABLED: "true" })).toBe(false);
    expect(actionsEnabledFromEnv({ DOXXD_ACTIONS_ENABLED: "0" })).toBe(false);
    expect(actionsEnabledFromEnv({ DOXXD_ACTIONS_ENABLED: " 1" })).toBe(false);
    expect(actionsEnabledFromEnv({ DOXXD_ACTIONS_ENABLED: "" })).toBe(false);
    expect(actionsEnabledFromEnv({})).toBe(false);
  });
});

describe("useActionsEnabled", () => {
  it("is false with no provider", () => {
    const { result } = renderHook(() => useActionsEnabled());
    expect(result.current).toBe(false);
  });

  it("follows the provider", () => {
    const wrapper = (enabled: boolean) =>
      function Wrapper({ children }: { children: ReactNode }) {
        return (
          <ActionsAvailabilityProvider enabled={enabled}>
            {children}
          </ActionsAvailabilityProvider>
        );
      };
    expect(
      renderHook(() => useActionsEnabled(), { wrapper: wrapper(true) }).result
        .current,
    ).toBe(true);
    expect(
      renderHook(() => useActionsEnabled(), { wrapper: wrapper(false) }).result
        .current,
    ).toBe(false);
  });
});
