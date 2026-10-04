import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { homeTitleOf, loadStoredAppName, persistAppName, tabTitleOf } from "../appName.ts";

const AppNameContext = createContext<{
  stored: string;
  homeTitle: string;
  setAppName: (name: string) => void;
} | null>(null);

export function AppNameProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState(loadStoredAppName);
  const homeTitle = homeTitleOf(stored);

  useEffect(() => {
    document.title = tabTitleOf(stored);
  }, [stored]);

  const value = useMemo(
    () => ({
      stored,
      homeTitle,
      setAppName: (name: string) => setStored(persistAppName(name)),
    }),
    [stored, homeTitle],
  );

  return <AppNameContext.Provider value={value}>{children}</AppNameContext.Provider>;
}

export function useAppName() {
  const value = useContext(AppNameContext);
  if (!value) throw new Error("useAppName 必须包在 AppNameProvider 里");
  return value;
}
