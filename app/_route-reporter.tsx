"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

export function RouteReporter() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.parent === window) return;
    try {
      window.parent.postMessage(
        { type: "back21:route", payload: { pathname } },
        "*",
      );
    } catch {}
  }, [pathname]);

  return null;
}
