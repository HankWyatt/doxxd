"use client";
import { createContext, useContext, type ReactNode } from "react";

const ActionsAvailabilityContext = createContext(false);

// The server decides (see `actionsEnabledFromEnv` in ./enabled) and passes the
// result down; the browser never reads the environment.
export function ActionsAvailabilityProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <ActionsAvailabilityContext.Provider value={enabled}>
      {children}
    </ActionsAvailabilityContext.Provider>
  );
}

export function useActionsEnabled(): boolean {
  return useContext(ActionsAvailabilityContext);
}
