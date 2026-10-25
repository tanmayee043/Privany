import { useEffect, useState } from "react";
import { Home } from "./screens/Home";
import { Running } from "./screens/Running";
import { ReportScreen } from "./screens/ReportScreen";

type Route = { name: "home" } | { name: "run"; id: string; site: string } | { name: "report"; id: string };

function parse(hash: string): Route {
  const run = hash.match(/^#\/run\/([\w-]+)(?:\?site=(.*))?$/);
  if (run) return { name: "run", id: run[1], site: decodeURIComponent(run[2] ?? "") };
  const report = hash.match(/^#\/report\/([\w-]+)$/);
  if (report) return { name: "report", id: report[1] };
  return { name: "home" };
}

export function go(hash: string) {
  window.location.hash = hash;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="min-h-dvh flex flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      {route.name === "home" && <Home />}
      {route.name === "run" && <Running jobId={route.id} site={route.site} />}
      {route.name === "report" && <ReportScreen id={route.id} />}
    </div>
  );
}
