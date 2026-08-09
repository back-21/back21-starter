/**
 * What this app is allowed to say about who is signed in.
 *
 * Run with `npm test` (Node 22+, no test framework installed).
 *
 * WHY THIS FILE EXISTS. `lib/auth.ts` turns a header set by somebody else's
 * Azure tenant into a person's name on a screen. Which claim types a real
 * directory sends has never been observed, so most of that file is fallbacks,
 * and a fallback nobody exercises is a guess. Every case below was written by
 * breaking the corresponding line first and checking the test went red.
 *
 * THE ONE THAT MATTERS MOST is "a header we cannot read is not an anonymous
 * visitor". Reporting a signed-in person as nobody is the same inversion that
 * once told a customer their app was "open to anyone who has the address" when
 * it was refusing every single request.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeIdentity,
  readIdentity,
  userOf,
  type Identity,
} from "../lib/identity.ts";

const OID = "http://schemas.microsoft.com/identity/claims/objectidentifier";

function principal(claims: Array<[string, string]>, nameTyp?: string): string {
  const body = JSON.stringify({
    auth_typ: "aad",
    name_typ: nameTyp,
    claims: claims.map(([typ, val]) => ({ typ, val })),
  });
  return Buffer.from(body, "utf-8").toString("base64");
}

function req(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

/** The deployed app, for the length of one test. */
function deployed<T>(fn: () => T): T {
  const before = process.env.WEBSITE_SITE_NAME;
  process.env.WEBSITE_SITE_NAME = "some-app";
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.WEBSITE_SITE_NAME;
    else process.env.WEBSITE_SITE_NAME = before;
  }
}

test("preview: no headers and no App Service means a stand-in, clearly labelled", () => {
  const identity = readIdentity(req({}));
  assert.equal(identity.status, "preview");
  assert.equal(userOf(readIdentity(req({})))?.isPreview, true);
  // The stand-in must never read as a real colleague. A plausible name here
  // would make the preview look like a working sign-in.
  const user = (identity as Extract<Identity, { status: "preview" }>).user;
  assert.match(user.name, /preview/i);
  assert.match(user.email, /preview|example/i);
});

test("deployed with no headers is anonymous, never the preview stand-in", () => {
  // Mutation: drop the WEBSITE_SITE_NAME check and every anonymous visitor to
  // the deployed app becomes a signed-in person.
  deployed(() => {
    assert.equal(readIdentity(req({})).status, "anonymous");
    assert.equal(userOf(readIdentity(req({}))), null);
  });
});

test("a standard Entra principal resolves to the person", () => {
  const identity = readIdentity(
    req({
      "x-ms-client-principal": principal([
        [OID, "8f1e-oid"],
        ["name", "Bjørn Håland"],
        ["preferred_username", "bjorn@contoso.no"],
      ]),
    }),
  );
  assert.equal(identity.status, "signed_in");
  const signed = identity as Extract<Identity, { status: "signed_in" }>;
  assert.equal(signed.user.id, "8f1e-oid");
  // UTF-8 through Buffer, not atob: `atob` would render this "BjÃ¸rn HÃ¥land".
  assert.equal(signed.user.name, "Bjørn Håland");
  assert.equal(signed.user.email, "bjorn@contoso.no");
  assert.deepEqual(signed.missing, []);
  assert.equal(describeIdentity(identity).message, null);
});

test("a claim under an unfamiliar namespace still resolves, by its leaf", () => {
  // Mutation: delete the leaf pass in `findClaim` and this tenant's users all
  // show up as a GUID.
  const identity = readIdentity(
    req({
      "x-ms-client-principal": principal([
        ["urn:example:tenant/identity/claims/objectidentifier", "oid-9"],
        ["https://contoso.example/claims/name", "Ada Lovelace"],
        ["https://contoso.example/claims/emailaddress", "ada@contoso.example"],
      ]),
    }),
  );
  const signed = identity as Extract<Identity, { status: "signed_in" }>;
  assert.equal(signed.status, "signed_in");
  assert.equal(signed.user.id, "oid-9");
  assert.equal(signed.user.name, "Ada Lovelace");
  assert.equal(signed.user.email, "ada@contoso.example");
});

test("an email is recognised by its shape when no claim type is familiar", () => {
  // Mutation: remove the email-shaped pass and this person is attributed by a
  // directory id, which no colleague of theirs can read.
  const identity = readIdentity(
    req({
      "x-ms-client-principal": principal([
        [OID, "oid-3"],
        ["urn:custom:workmail", "kari@contoso.no"],
      ]),
    }),
  );
  const signed = identity as Extract<Identity, { status: "signed_in" }>;
  assert.equal(signed.user.email, "kari@contoso.no");
  assert.deepEqual(signed.missing, ["name"]);
});

test("a header we cannot decode is UNREADABLE, never anonymous", () => {
  // The load-bearing case. Mutation: return `{ status: "anonymous" }` from the
  // catch and the app tells a signed-in person nobody is signed in, which
  // sends whoever reads it to fix the wrong thing entirely.
  const identity = deployed(() =>
    readIdentity(req({ "x-ms-client-principal": "not base64 json at all" })),
  );
  assert.equal(identity.status, "unreadable");
  assert.equal(userOf(readIdentity(req({ "x-ms-client-principal": "%%%" }))), null);
  const message = describeIdentity(identity).message ?? "";
  assert.ok(message.length > 0);
  assert.doesNotMatch(message, /unknown/i);
});

test("a principal that names nobody is UNREADABLE, and says the mapping is wrong", () => {
  // Decodes cleanly, carries nothing that identifies a person. Mutation:
  // `if (!id) return { status: "anonymous" }` and a claims-mapping problem is
  // reported as an empty chair.
  const identity = deployed(() =>
    readIdentity(req({ "x-ms-client-principal": principal([["roles", "reader"]]) })),
  );
  assert.equal(identity.status, "unreadable");
  const described = describeIdentity(identity);
  assert.match(described.message ?? "", /claim/i);
  // The claim types that DID arrive are reported, because they are the only
  // clue to which mapping needs fixing.
  assert.deepEqual(described.claimTypes, ["roles"]);
});

test("signed in with no name is signed in, and says what is missing", () => {
  // The state that produces the word "unknown" in a naive version, or prints a
  // directory object id where a person's name belongs.
  const identity = readIdentity(
    req({ "x-ms-client-principal": principal([[OID, "oid-7"]]) }),
  );
  const signed = identity as Extract<Identity, { status: "signed_in" }>;
  assert.equal(signed.status, "signed_in");
  assert.deepEqual([...signed.missing].sort(), ["email", "name"]);

  const described = describeIdentity(identity);
  assert.equal(described.user?.displayName, "oid-7");
  assert.match(described.message ?? "", /did not send/i);
  assert.doesNotMatch(described.message ?? "", /unknown/i);
});

test("the simple headers alone are enough when the encoded one is missing", () => {
  // A proxy that drops one header may keep the others.
  const identity = deployed(() =>
    readIdentity(
      req({
        "x-ms-client-principal-name": "per@contoso.no",
        "x-ms-client-principal-id": "oid-11",
      }),
    ),
  );
  const signed = identity as Extract<Identity, { status: "signed_in" }>;
  assert.equal(signed.status, "signed_in");
  assert.equal(signed.user.id, "oid-11");
  assert.equal(signed.user.email, "per@contoso.no");
  assert.equal(signed.user.isPreview, false);
});

test("every state produces something a person can read, and never an empty name", () => {
  const cases: Headers[] = [
    req({}),
    req({ "x-ms-client-principal": "garbage" }),
    req({ "x-ms-client-principal": principal([[OID, "oid-1"]]) }),
    req({
      "x-ms-client-principal": principal([
        [OID, "oid-2"],
        ["name", "Nora"],
        ["email", "nora@contoso.no"],
      ]),
    }),
  ];
  for (const headers of cases) {
    for (const asDeployed of [false, true]) {
      const described = asDeployed
        ? deployed(() => describeIdentity(readIdentity(headers)))
        : describeIdentity(readIdentity(headers));
      if (described.user) assert.notEqual(described.user.displayName, "");
      if (described.status !== "signed_in" || described.missing.length > 0) {
        assert.ok(
          (described.message ?? "").length > 0,
          `status ${described.status} said nothing`,
        );
      }
      assert.doesNotMatch(JSON.stringify(described), /"unknown"/i);
    }
  }
});
