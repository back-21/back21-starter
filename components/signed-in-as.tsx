"use client";

/**
 * "Signed in as ..." for the app's header.
 *
 * An app behind Microsoft Entra should be able to say who you are. This one
 * could not: on 2026-08-09 a deployed customer app showed nothing at all and
 * made the signed-in person type their own name into a form. The distance
 * between having an identity and showing it is this component, so it ships.
 *
 * WHY IT IS NOT JUST `{user.name}`. Five of its seven states are not a name,
 * and each of them has to say something a non-developer can act on:
 *
 *   preview      nobody signs in to the preview, so a bare name here would
 *                claim a working sign-in that has never been checked
 *   anonymous    nobody is signed in
 *   unreadable   Azure signed somebody in and the app cannot tell who, which
 *                is a claims-mapping problem, not an anonymous visitor
 *   unavailable  the lookup failed, so the app does not know
 *   incomplete   signed in, but the directory sent no name for them
 *
 * The last one is the one that produces "unknown" in a naive version, or
 * prints a directory object id where a person's name belongs. It says what is
 * missing instead.
 *
 * Restyle it freely. The classes are plain Tailwind and `className` merges.
 * Do not delete the qualifiers: the words are the point, not the box.
 */

import { CircleAlert, TriangleAlert, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/use-current-user";

export function SignedInAs({ className }: { className?: string }) {
  const { status, user, message, loading } = useCurrentUser();

  const base = cn(
    "inline-flex items-center gap-2 text-sm text-muted-foreground",
    className,
  );

  if (loading) {
    return (
      <span className={base} aria-live="polite">
        <UserRound className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
        <span className="opacity-60">Checking sign-in</span>
      </span>
    );
  }

  if (status === "signed_in" && user) {
    return (
      <span className={base}>
        <UserRound className="h-4 w-4 shrink-0" aria-hidden />
        {message === null ? (
          <span>
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {user.displayName}
            </span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span>Signed in</span>
            <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{message}</span>
          </span>
        )}
      </span>
    );
  }

  if (status === "preview" && user) {
    return (
      <span className={base}>
        <UserRound className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
        <span>
          <span className="font-medium text-foreground">{user.displayName}</span>{" "}
          (preview stand-in, nobody is signed in here)
        </span>
      </span>
    );
  }

  return (
    <span className={cn(base, "text-amber-700 dark:text-amber-400")}>
      <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
      <span>{message ?? "Not signed in."}</span>
    </span>
  );
}
