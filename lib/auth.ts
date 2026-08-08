/**
 * Who is signed in.
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
 */

import { headers } from "next/headers";

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

function firstOf(
  claims: Record<string, string>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    const value = claims[name];
    if (value) return value;
  }
  return null;
}

/**
 * The signed-in person, or null when nobody is signed in.
 *
 * Server side only: it reads request headers. Call it from a Route Handler
 * (`app/api/.../route.ts`) or a `"use server"` action, and send what the screen
 * needs to the browser from there. Pass `request.headers` when you have a
 * `Request` in hand; otherwise it reads Next's request-scoped headers itself.
 */
export function getCurrentUser(source?: Headers): CurrentUser | null {
  const bag = source ?? headers();
  const raw = bag.get(PRINCIPAL_HEADER);

  if (!raw) {
    // Fall back to the simple headers before giving up: App Service sets these
    // alongside the encoded principal, and a proxy that drops one may keep the
    // others.
    const name = bag.get(NAME_HEADER);
    const id = bag.get(ID_HEADER);
    if (name || id) {
      return {
        id: id ?? name!,
        email: name ?? "",
        name: name ?? id!,
        claims: {},
        isPreview: false,
      };
    }
    return isDeployed() ? null : PREVIEW_USER;
  }

  let principal: ClientPrincipal;
  try {
    principal = JSON.parse(decodeBase64(raw)) as ClientPrincipal;
  } catch {
    // A header we cannot read is not a person. Never guess one into existence.
    return null;
  }

  const claims: Record<string, string> = {};
  for (const claim of principal.claims ?? []) {
    if (claim?.typ && typeof claim.val === "string") claims[claim.typ] = claim.val;
  }
  if (principal.name_typ && claims[principal.name_typ]) {
    claims.name = claims.name ?? claims[principal.name_typ];
  }

  const email =
    firstOf(claims, EMAIL_CLAIMS) ?? bag.get(NAME_HEADER) ?? "";
  const id = firstOf(claims, ID_CLAIMS) ?? bag.get(ID_HEADER) ?? email;
  if (!id) return null;

  return {
    id,
    email,
    name: firstOf(claims, NAME_CLAIMS) ?? email ?? id,
    claims,
    isPreview: false,
  };
}
