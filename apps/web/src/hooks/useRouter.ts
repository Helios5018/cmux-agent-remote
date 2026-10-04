import { useCallback, useEffect, useState } from "react";

/**
 * 极简 hash 路由（不引第三方依赖，手机上加载更快）。
 *   #/            首页：cmux 结构树
 *   #/w/:id       只看某一个 workspace（深链；`all` 等于首页）
 *   #/s/:id       Agent 会话页
 */
export type Route =
  | { name: "inbox" }
  | { name: "workspace"; workspaceId: string }
  | { name: "session"; surfaceId: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) return { name: "workspace", workspaceId: decodeURIComponent(parts[1]) };
  if (parts[0] === "s" && parts[1]) return { name: "session", surfaceId: decodeURIComponent(parts[1]) };
  return { name: "inbox" };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "workspace":
      return `#/w/${encodeURIComponent(route.workspaceId)}`;
    case "session":
      return `#/s/${encodeURIComponent(route.surfaceId)}`;
    default:
      return "#/";
  }
}

export function useRouter() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeToHash(next);
  }, []);

  const back = useCallback(() => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "#/";
  }, []);

  return { route, navigate, back };
}
