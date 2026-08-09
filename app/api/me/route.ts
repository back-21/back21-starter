/**
 * Who is signed in, for the browser.
 *
 * Screens in this stack are `"use client"` components (Server Components must
 * stay synchronous here, so a page cannot read request headers), which means
 * identity can only reach a screen through a Route Handler. This is that
 * handler, and it ships in the starter on purpose: an app that has to invent
 * this file before it can greet anybody by name is an app that greets nobody.
 * Measured 2026-08-09, a deployed app made the signed-in person type their own
 * name into a field called "Host name".
 *
 * Consume it with `useCurrentUser()` from `@/lib/use-current-user`, not with a
 * hand-written fetch. The shape it answers with, and the sentence each state
 * produces, live in `lib/auth.ts` as `describeIdentity`.
 *
 * `force-dynamic` because this reads request headers: without it Next 14 can
 * evaluate the handler at build time, which would freeze one person's identity
 * into the app for everybody.
 *
 * Always 200. A 401 here would be a lie in both directions: the deployed app
 * sits behind Azure sign-in, so an unauthenticated request never gets this far,
 * and in the preview nobody is signed in by design. The status field carries
 * the answer, and `message` carries a sentence the screen can show a person.
 */

import { NextResponse } from "next/server";
import { describeIdentity, getIdentity, type MeResponse } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse<MeResponse>> {
  return NextResponse.json(describeIdentity(getIdentity(request.headers)));
}
