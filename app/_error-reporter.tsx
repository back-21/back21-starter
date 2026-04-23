"use client";

import { useEffect } from "react";

export function ErrorReporter() {
  useEffect(() => {
    if (window.parent === window) return;

    function send(payload: Record<string, unknown>) {
      try {
        window.parent.postMessage({ type: "back21:error", payload }, "*");
      } catch {}
    }

    function onError(ev: ErrorEvent) {
      send({
        source: "iframe",
        message: ev.message || String(ev.error),
        stack: ev.error?.stack,
        file: ev.filename,
        line: ev.lineno,
        col: ev.colno,
      });
    }

    function onRejection(ev: PromiseRejectionEvent) {
      const reason = ev.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason);
      send({
        source: "unhandledrejection",
        message,
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    }

    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      originalError(...args);
      const first = args[0];
      const message =
        first instanceof Error ? first.message : args.map(String).join(" ");
      send({
        source: "console",
        message: message.slice(0, 2000),
        stack: first instanceof Error ? first.stack : undefined,
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = originalError;
    };
  }, []);

  return null;
}
