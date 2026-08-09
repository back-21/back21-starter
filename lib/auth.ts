/**
 * Who is signed in. This is the file app code imports.
 *
 * SIGN-IN IS NOT PART OF THIS APP. Back21 sets it up as infrastructure in the
 * customer's own Microsoft Entra directory, in front of the app, so people sign
 * in with the work account they already have and this app never sees a
 * password. Azure App Service checks the person BEFORE the request reaches any
 * code here and injects their claims as a base64 JSON request header,
 * `x-ms-client-principal`. Reading that header is the whole job, and
 * `lib/identity.ts` is the only place it is read.
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
 * THE WHOLE PATH SHIPS, not just this function. Measured on 2026-08-09 in a
 * deployed customer app: sign-in worked, the person got in, and then had to
 * type their own name into a field called "Host name". `getCurrentUser()`
 * existed and nothing called it, because using it meant writing a route
 * handler, a fetch and a loading state first. Those are here now:
 * `app/api/me/route.ts`, `lib/use-current-user.ts`, `components/signed-in-as.tsx`.
 */

import { headers } from "next/headers";

import { readIdentity, userOf, type CurrentUser, type Identity } from "./identity";

export {
  describeIdentity,
  displayName,
  type CurrentUser,
  type Identity,
  type MeResponse,
  type MissingClaim,
} from "./identity";

/**
 * Everything the app can honestly say about who is making this request.
 *
 * Server side only: it reads request headers. Pass `request.headers` when you
 * have a `Request` in hand; otherwise it reads Next's request-scoped headers.
 *
 * Most app code does not call this. It backs `app/api/me/route.ts`, which is
 * what the browser talks to. Call `getCurrentUser()` when you are stamping a
 * row and only need the person.
 */
export function getIdentity(source?: Headers): Identity {
  return readIdentity(source ?? headers());
}

/**
 * The signed-in person, or null when there is nobody to attribute this to.
 *
 * This is the one to call when you are writing a row: it gives you the person
 * or nothing, which is exactly the choice a `created_by` column needs.
 *
 * Server side only. Call it from a Route Handler (`app/api/.../route.ts`) or a
 * `"use server"` action, and send what the screen needs to the browser from
 * there. NEVER take the person from the request body: the browser can put any
 * name it likes in there, and an attribution column filled from the body
 * records who the browser claimed to be, which is not the same fact.
 */
export function getCurrentUser(source?: Headers): CurrentUser | null {
  return userOf(getIdentity(source));
}
