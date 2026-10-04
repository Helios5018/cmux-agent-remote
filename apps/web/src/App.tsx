import { AppNameProvider } from "./hooks/useAppName.tsx";
import { useRouter } from "./hooks/useRouter.ts";
import { HomePage } from "./pages/HomePage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { AppStoreProvider, useAppStore } from "./stores/AppStore.tsx";

function Router() {
  const { session, loading } = useAppStore();
  const { route, navigate, back } = useRouter();

  if (loading) return <div className="boot">加载中…</div>;
  if (!session?.authenticated) return <LoginPage />;

  switch (route.name) {
    case "session":
      return <SessionPage key={route.surfaceId} surfaceId={route.surfaceId} back={back} navigate={navigate} />;
    case "workspace":
      // #/w/all 是旧链接，等价于首页的完整结构树。
      return route.workspaceId === "all" ? (
        <HomePage navigate={navigate} />
      ) : (
        <HomePage navigate={navigate} back={back} workspaceId={route.workspaceId} />
      );
    default:
      return <HomePage navigate={navigate} />;
  }
}

export function App() {
  return (
    <AppStoreProvider>
      <AppNameProvider>
        <Router />
      </AppNameProvider>
    </AppStoreProvider>
  );
}
