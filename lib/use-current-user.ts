"use client";

/**
 * Who is signed in, in a client component.
 *
 * Screens here are `"use client"`, so they cannot read request headers. This
 * hook is how identity gets to them: one fetch of `/api/me`, shared by every
 * component on the page, exposed as state a screen can render honestly.
 *
 * WHY A HOOK AND NOT "the model can write a fetch". It can, and on 2026-08-09
 * it wrote none: a deployed app behind Microsoft Entra asked the signed-in
 * person to type their own name. The distance between "the identity exists"
 * and "the screen shows it" was a route handler, a fetch, a loading state and a
 * race condition, and that distance is what did not get crossed. It is crossed
 * here, once.
 *
 * NEVER render `user` without looking at `status`. In the preview `user` is a
 * stand-in, and a screen that prints "Signed in as Preview User" with no
 * qualifier is telling the customer their sign-in works when nothing has been
 * checked. `<SignedInAs />` handles all of it; prefer it.
 */

import { useCallback, useEffect, useState } from "react";

export type MeUser = {
  id: string;
  email: string;
  name: string;
  /** Never empty, never "unknown". Safe to render directly. */
  displayName: string;
  isPreview: boolean;
};

export type MeStatus =
  /** A real person, described. */
  | "signed_in"
  /** The Back21 preview or local dev. `user` is a stand-in, not a person. */
  | "preview"
  /** Nobody is signed in. */
  | "anonymous"
  /** Azure signed somebody in and the app cannot tell who. */
  | "unreadable"
  /** `/api/me` did not answer. The app does not know, and says so. */
  | "unavailable";

export type CurrentUserState = {
  status: MeStatus | null;
  user: MeUser | null;
  /** Claims the directory did not send: `"name"`, `"email"`. */
  missing: readonly string[];
  /** A sentence to show the person when there is something to explain. */
  message: string | null;
  /** Claim types the tenant sent. For diagnosing a missing name. */
  claimTypes: readonly string[];
  loading: boolean;
};

type Payload = Omit<CurrentUserState, "loading">;

const LOADING: CurrentUserState = {
  status: null,
  user: null,
  missing: [],
  message: null,
  claimTypes: [],
  loading: true,
};

/**
 * One request per page load, shared by every component that asks.
 *
 * A badge in the header and a prefilled field in a form both want this, and
 * two components mounting must not mean two round trips. The promise is cached,
 * not the result, so simultaneous callers await the same fetch.
 */
let inFlight: Promise<Payload> | null = null;

function fetchMe(): Promise<Payload> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/me", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`/api/me answered ${res.status}`);
      const body = (await res.json()) as Partial<Payload>;
      return {
        status: (body.status ?? "unavailable") as MeStatus,
        user: body.user ?? null,
        missing: body.missing ?? [],
        message: body.message ?? null,
        claimTypes: body.claimTypes ?? [],
      };
    })
    .catch(() => {
      // A failed lookup is not an anonymous visitor and is definitely not a
      // signed-in person. It is the app not knowing, which is its own answer
      // and the only honest one.
      inFlight = null;
      return {
        status: "unavailable" as const,
        user: null,
        missing: [],
        message: "Could not check who is signed in.",
        claimTypes: [],
      };
    });
  return inFlight;
}

export function useCurrentUser(): CurrentUserState {
  const [state, setState] = useState<CurrentUserState>(LOADING);

  useEffect(() => {
    let alive = true;
    fetchMe().then((payload) => {
      if (alive) setState({ ...payload, loading: false });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/**
 * A form field that starts out as the signed-in person and stays editable.
 *
 * For "Host name", "Reported by", "Requested by": fields whose answer is
 * almost always the person filling the form in. Spread it straight onto an
 * input:
 *
 *     const host = useMyField();
 *     <input {...host.inputProps} />
 *
 * It fills in when the lookup lands, and it does NOT overwrite anything the
 * person has already typed, which is the race a hand-written version gets
 * wrong. `pick` chooses which part of them to use; the default is their
 * display name.
 *
 * PREFILLED, NOT LOCKED. The value stays editable, always. A visitor log where
 * the host is somebody else, a fault reported on a colleague's behalf: those
 * are ordinary, and a read-only field turns them into a support call. Locking a
 * field is also not security. If a value must be the signed-in person, set it
 * on the server from `getCurrentUser()` and ignore what the browser sent.
 */
export function useMyField(pick?: (user: MeUser) => string): {
  value: string;
  setValue: (next: string) => void;
  inputProps: {
    value: string;
    onChange: (event: { target: { value: string } }) => void;
  };
  /** True while the value is still the one filled in for them. */
  isPrefilled: boolean;
  /** The identity state behind it, for a screen that wants to explain itself. */
  identity: CurrentUserState;
} {
  const identity = useCurrentUser();
  const [value, setValueState] = useState("");
  const [touched, setTouched] = useState(false);

  const setValue = useCallback((next: string) => {
    setTouched(true);
    setValueState(next);
  }, []);

  useEffect(() => {
    if (touched || !identity.user) return;
    const next = pick ? pick(identity.user) : identity.user.displayName;
    // Only ever fills an untouched field, so a person who started typing
    // before the lookup landed keeps what they wrote.
    if (next) setValueState(next);
    // `pick` is usually an inline arrow, so it is deliberately not a dependency:
    // including it would re-run this on every render and fight the person's
    // typing. The identity is what can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.user, touched]);

  return {
    value,
    setValue,
    inputProps: {
      value,
      onChange: (event) => setValue(event.target.value),
    },
    isPrefilled: !touched && value !== "",
    identity,
  };
}
