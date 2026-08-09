/**
 * Reading Azure's sign-in header. Pure functions, no request.
 *
 * DO NOT IMPORT THIS FILE FROM APP CODE. Import `@/lib/auth`, which is the
 * same thing bound to the request you are handling. This file exists apart
 * from it for one reason: `lib/auth.ts` imports `next/headers`, which only
 * resolves inside a Next build, and the header parsing below is the part that
 * has to be testable without one (`tests/identity.test.ts`, `npm test`).
 *
 * SIGN-IN IS NOT PART OF THIS APP. Back21 sets it up as infrastructure in the
 * customer's own Microsoft Entra directory, in front of the app, so people sign
 * in with the work account they already have and this app never sees a
 * password. Azure App Service checks the person BEFORE the request reaches any
 * code here and injects their claims as a base64 JSON request header,
 * `x-ms-client-principal`. Reading that header is the whole job, and this file
 * is the only place it is read.
 *
 * External callers cannot set these headers. App Service strips them from
 * incoming requests and sets them itself, which is why no signature check is
 * needed here:
 * https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-user-identities
 *
 * DO NOT replace this with an authentication library. Nothing in the platform
 * sets `ENTRA_CLIENT_ID`, `NEXTAUTH_SECRET` or anything like them, so a library
 * configured from environment variables cannot sign anybody in, and an app
 * whose screens are gated behind one cannot be used by anybody. That has
 * happened, on 2026-08-08, in a real customer app.
 *
 * WHY THERE IS MORE HERE THAN `getCurrentUser()`. Measured on 2026-08-09 in a
 * deployed customer app: sign-in worked, the person got in, and then had to
 * type their own name into a field called "Host name". The app never asked who
 * they were. `getCurrentUser()` existed and nothing called it. A helper that is
 * only reachable by writing a route handler, a fetch and a loading state first
 * is a helper that does not get used, so this file now ships the whole path:
 * the honest read (`getIdentity`), the browser exposure
 * (`app/api/me/route.ts`), the hook (`lib/use-current-user.ts`) and the badge
 * (`components/signed-in-as.tsx`).
 *
 * NEVER "unknown". Every state below has a sentence a non-developer can act on.
 * A screen that renders the word "unknown", or a directory object id where a
 * person's name should be, is this file failing quietly. The claim types the
 * tenant actually sends are still unverified against a real directory, so the
 * unreadable and incomplete cases are real possibilities, not defensive
 * padding: `/api/me` reports which claim types arrived so a human can see.
 */

export type CurrentUser = {
  /** Stable identifier from the directory. Use this as the foreign key. */
  id: string;
  /** Work email, or the sign-in name when the directory sends no email claim. */
  email: string;
  /** Display name, falling back to the email when the directory sends none. */
  name: string;
  /** Every claim App Service passed through, keyed by claim type. */
  claims: Record<string, string>;
  /**
   * True when this is the local stand-in rather than a real signed-in person.
   * Never true on the deployed app.
   */
  isPreview: boolean;
};

type ClientPrincipal = {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: Array<{ typ?: string; val?: string }>;
};

const PRINCIPAL_HEADER = "x-ms-client-principal";
const NAME_HEADER = "x-ms-client-principal-name";
const ID_HEADER = "x-ms-client-principal-id";

/**
 * App Service applies a default claims mapping, so the same value can arrive
 * under a short OpenID Connect name or a long WS-Federation URI depending on
 * the tenant's configuration. Both spellings are tried, most specific first.
 */
const ID_CLAIMS = [
  "http://schemas.microsoft.com/identity/claims/objectidentifier",
  "oid",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
  "sub",
];

const EMAIL_CLAIMS = [
  "preferred_username",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "email",
  "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
];

const NAME_CLAIMS = [
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "given_name",
];

/**
 * The person you are when you run the app locally or in the Back21 preview.
 *
 * The preview is a browser sandbox that does not sit behind App Service, so
 * the header is absent there and always will be. Without a stand-in every
 * preview would look permanently logged out, which is exactly the state that
 * makes someone build a login screen to "fix" it.
 *
 * The values are deliberately obvious fakes. A stand-in called "Anna Berg"
 * would make the preview look like a working sign-in, and the person reviewing
 * the app would never learn that the preview cannot check anybody. Anything
 * that renders this user has to say it is a stand-in; `<SignedInAs />` does.
 */
const PREVIEW_USER: CurrentUser = {
  id: "preview-user",
  email: "preview@example.com",
  name: "Preview User",
  claims: {},
  isPreview: true,
};

/**
 * `WEBSITE_SITE_NAME` is a read-only environment variable App Service sets on
 * every app it hosts:
 * https://learn.microsoft.com/en-us/azure/app-service/reference-app-settings
 *
 * It is the difference between "there is no header because this is a preview"
 * and "there is no header because nobody is signed in". Handing out the
 * stand-in user in the second case would mean every anonymous visitor to the
 * deployed app is treated as a signed-in person, so the deployed app returns
 * null instead, always.
 */
function isDeployed(): boolean {
  return (
    typeof process !== "undefined" && Boolean(process.env.WEBSITE_SITE_NAME)
  );
}

/**
 * Base64 through `Buffer` where it exists, because `atob` decodes to Latin-1
 * and would turn a name like "Bjørn Håland" into mojibake.
 */
function decodeBase64(value: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf-8");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/** The part after the last slash: `.../claims/emailaddress` becomes `emailaddress`. */
function claimLeaf(type: string): string {
  const i = type.lastIndexOf("/");
  return (i === -1 ? type : type.slice(i + 1)).toLowerCase();
}

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Find a claim, tolerating a spelling this file has never seen.
 *
 * Which claim types a tenant sends is configuration we do not control and have
 * not yet observed in a real directory, so an exact-match list is a guess about
 * somebody else's setup. Three passes, weakest last:
 *
 *   1. exact type match, in the order given
 *   2. same leaf under a different namespace, so a tenant that issues
 *      `http://example.com/identity/claims/emailaddress` still resolves
 *   3. for email only, any claim whose value is email shaped
 *
 * Pass 3 is the one that keeps a real person from being rendered as a GUID.
 * It cannot invent an identity: it only reads values App Service already
 * vouched for.
 */
function findClaim(
  claims: Record<string, string>,
  names: readonly string[],
  opts?: { emailShaped?: boolean },
): string | null {
  for (const name of names) {
    const value = claims[name];
    if (value) return value;
  }

  const leaves = new Set(names.map(claimLeaf));
  for (const [type, value] of Object.entries(claims)) {
    if (value && leaves.has(claimLeaf(type))) return value;
  }

  if (opts?.emailShaped) {
    for (const value of Object.values(claims)) {
      if (value && EMAIL_SHAPED.test(value)) return value;
    }
  }

  return null;
}

/** A claim the app expected and the directory did not send. */
export type MissingClaim = "name" | "email";

/**
 * Everything the app can honestly say about who is making this request.
 *
 * Four states, and the reason there are four rather than "user or null" is
 * that `null` collapses three very different situations into one word. Nobody
 * signed in, the header arrived and could not be decoded, and the header
 * decoded to nothing that identifies a person all become "unknown" on screen,
 * and "unknown" is the answer the person reading it can do nothing with.
 *
 * `unreadable` in particular must never be reported as `anonymous`. That is the
 * inversion from [[reference-a-guard-that-could-never-see-its-own-proof]]: a
 * signal the code did not understand, printed to the customer as the strongest
 * claim it could make.
 */
export type Identity =
  | {
      status: "signed_in";
      user: CurrentUser;
      /**
       * Claims the directory did not send. The person IS signed in; the app
       * just cannot show a name or an email for them, and says so instead of
       * printing the object id as if it were a name.
       */
      missing: readonly MissingClaim[];
      /** Claim types that arrived, for diagnosing a tenant's mapping. */
      claimTypes: readonly string[];
    }
  | { status: "preview"; user: CurrentUser }
  | { status: "anonymous" }
  | {
      status: "unreadable";
      /** Plain English, safe to render. Never contains claim values. */
      reason: string;
      claimTypes: readonly string[];
    };

/**
 * Who these request headers belong to, with the reason when the answer is not
 * a person.
 *
 * App code calls `getIdentity()` from `@/lib/auth` instead, which hands this
 * the right headers.
 */
export function readIdentity(bag: Headers): Identity {
  const raw = bag.get(PRINCIPAL_HEADER);
  const headerName = bag.get(NAME_HEADER);
  const headerId = bag.get(ID_HEADER);

  if (!raw) {
    // Fall back to the simple headers before giving up: App Service sets these
    // alongside the encoded principal, and a proxy that drops one may keep the
    // others.
    if (headerName || headerId) {
      const id = headerId ?? headerName!;
      return {
        status: "signed_in",
        user: {
          id,
          email: headerName ?? "",
          name: headerName ?? id,
          claims: {},
          isPreview: false,
        },
        missing: headerName ? [] : ["name", "email"],
        claimTypes: [],
      };
    }
    return isDeployed() ? { status: "anonymous" } : { status: "preview", user: PREVIEW_USER };
  }

  let principal: ClientPrincipal;
  try {
    principal = JSON.parse(decodeBase64(raw)) as ClientPrincipal;
  } catch {
    // A header we cannot read is not a person, and it is not nobody either.
    // Never guess an identity into existence, and never call this anonymous.
    return {
      status: "unreadable",
      reason:
        "Azure sent sign-in details this app could not decode. The person is signed in, but the app cannot tell who they are.",
      claimTypes: [],
    };
  }

  const claims: Record<string, string> = {};
  for (const claim of principal.claims ?? []) {
    if (claim?.typ && typeof claim.val === "string") claims[claim.typ] = claim.val;
  }
  if (principal.name_typ && claims[principal.name_typ]) {
    claims.name = claims.name ?? claims[principal.name_typ];
  }
  const claimTypes = Object.keys(claims).sort();

  const email = findClaim(claims, EMAIL_CLAIMS, { emailShaped: true }) ?? headerName ?? "";
  const name = findClaim(claims, NAME_CLAIMS);
  const id = findClaim(claims, ID_CLAIMS) ?? headerId ?? email;

  if (!id) {
    // The header decoded and carried nothing that names a person. This is a
    // tenant claims-mapping problem, not an anonymous visitor, and reporting it
    // as "not signed in" would send someone to fix the wrong thing.
    return {
      status: "unreadable",
      reason:
        "Azure signed this person in but sent no claim identifying them, so the app has nobody to attribute this to. The directory's token configuration needs an id, email or name claim.",
      claimTypes,
    };
  }

  const missing: MissingClaim[] = [];
  if (!name) missing.push("name");
  if (!email) missing.push("email");

  return {
    status: "signed_in",
    user: { id, email, name: name ?? email ?? id, claims, isPreview: false },
    missing,
    claimTypes,
  };
}

/** The person an identity describes, or null when it describes nobody. */
export function userOf(identity: Identity): CurrentUser | null {
  return identity.status === "signed_in" || identity.status === "preview"
    ? identity.user
    : null;
}

/**
 * Something to put on screen for a person, never an empty string and never the
 * word "unknown". Falls back name to email to id, in that order, because a
 * directory object id is at least a true fact about them.
 */
export function displayName(user: CurrentUser): string {
  return user.name || user.email || user.id;
}

/** What `GET /api/me` answers. See `app/api/me/route.ts`. */
export type MeResponse = {
  status: Identity["status"];
  user: {
    id: string;
    email: string;
    name: string;
    /** Never empty, never the word "unknown". Safe to render directly. */
    displayName: string;
    isPreview: boolean;
  } | null;
  /** Claims the directory did not send: `"name"`, `"email"`. */
  missing: readonly string[];
  /**
   * Plain English for the person looking at the screen, or null when there is
   * nothing to explain because a real person is signed in and fully described.
   */
  message: string | null;
  /**
   * Claim types this tenant sent. Empty on the preview. The reason it is here:
   * which claim types a real directory sends has never been observed, so when
   * a name is missing this is what tells a human which mapping to fix.
   */
  claimTypes: readonly string[];
};

/**
 * Turn an identity into the answer the browser gets.
 *
 * It lives here rather than in the route handler because Next 14 rejects any
 * export from a `route.ts` that is not a handler or a route config field, and
 * because the interesting part, the sentence each state produces, is worth
 * being able to test without a request.
 */
export function describeIdentity(identity: Identity): MeResponse {
  switch (identity.status) {
    case "signed_in": {
      const { user, missing, claimTypes } = identity;
      const message =
        missing.length === 0
          ? null
          : `You are signed in, but your organisation's directory did not send ${
              missing.length === 2 ? "a name or an email" : `a ${missing[0]}`
            } for you, so this app cannot show who you are.`;
      return {
        status: "signed_in",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          displayName: displayName(user),
          isPreview: false,
        },
        missing,
        message,
        claimTypes,
      };
    }
    case "preview":
      return {
        status: "preview",
        user: {
          id: identity.user.id,
          email: identity.user.email,
          name: identity.user.name,
          displayName: displayName(identity.user),
          isPreview: true,
        },
        missing: [],
        message:
          "This is the preview, which nobody signs in to. On the deployed app this shows the person's real work account.",
        claimTypes: [],
      };
    case "anonymous":
      return {
        status: "anonymous",
        user: null,
        missing: [],
        message: "Nobody is signed in.",
        claimTypes: [],
      };
    case "unreadable":
      return {
        status: "unreadable",
        user: null,
        missing: [],
        message: identity.reason,
        claimTypes: identity.claimTypes,
      };
  }
}
