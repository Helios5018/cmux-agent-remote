import { Fragment, useLayoutEffect, useRef, useState } from "react";

/** Display paths without changing the absolute paths sent to the file API. */
export function PathBreadcrumbs({ path, home, roots, onNavigate }: {
  path: string; home: string; roots: string[]; onNavigate: (path: string) => void;
}) {
  const inHome = !!home && (path === home || path.startsWith(`${home}/`));
  const base = inHome ? home : "/";
  const parts = (inHome ? path.slice(home.length) : path).split("/").filter(Boolean);
  const crumbs = [{ name: inHome ? "~" : "/", path: base }];
  for (const name of parts) {
    const parent = crumbs[crumbs.length - 1]!.path;
    crumbs.push({ name, path: `${parent === "/" ? "" : parent}/${name}` });
  }
  const scroller = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const el = scroller.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1 });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, [path, home]);
  return <div className={`file-breadcrumb-wrap${edges.left ? " overflow-left" : ""}${edges.right ? " overflow-right" : ""}`}>
    <nav ref={scroller} className="file-breadcrumbs" aria-label="当前目录路径" title={path} onScroll={updateEdges}>
      {crumbs.map((crumb, index) => {
        const current = index === crumbs.length - 1;
        const allowed = roots.some((root) => crumb.path === root || crumb.path.startsWith(root === "/" ? "/" : `${root}/`));
        return <Fragment key={crumb.path}>
          {index > 0 && !(index === 1 && base === "/") && <span className="file-path-separator" aria-hidden="true">/</span>}
          {allowed && !current ? <button title={crumb.path} onClick={() => onNavigate(crumb.path)}>{crumb.name}</button>
            : <span className={current ? "file-path-current" : "file-path-ancestor"} aria-current={current ? "location" : undefined}>{crumb.name}</span>}
        </Fragment>;
      })}
    </nav>
  </div>;
}
