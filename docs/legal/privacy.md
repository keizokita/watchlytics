# Watchlytics — Privacy Policy

**Last updated:** 2026-09-11 · **Consent notice version:** `2026-09-11`
**Effective date:** 2026-09-11

> This policy is written for the closed beta. It describes what the product
> actually does today — not what it might do later. Every claim below can be
> checked against the code in this repository.

## Who is responsible for your data

| | |
|---|---|
| Controller | Keizo Kita, a natural person resident in Brazil, acting as controller in his own name. There is no company behind Watchlytics. Written contact goes to the address below. |
| Privacy contact | keizokita1+watchlytics@gmail.com |
| Data Protection Officer (LGPD art. 41) | None appointed. As a small-scale processing agent we are exempt from appointing one (ANPD Resolução CD/ANPD nº 2/2022), and keep the communication channel that exemption requires: the privacy contact above, answered by the controller himself. |
| EU/EEA representative (GDPR art. 27) | None appointed, because none is required: the beta is invite-only and is not offered to people in the EU, the EEA or the UK, and we do not target or monitor anyone there. If we ever invite someone living in those countries, we appoint a representative first. |

If you are in Brazil, this policy covers our obligations under the **LGPD**
(Lei 13.709/2018). If you are in the EU, the UK or the EEA, it covers the
**GDPR**. Where the two differ, we apply whichever is stricter.

## What we collect

We collect only what the app needs to work. There is no analytics product, no
advertising network, no tracking pixel and no third-party script on the page.

**From your Google account,** when you sign in with Google:

- your Google account identifier (the `sub` claim) — this is the only thing we
  use to recognise you on your next sign-in;
- your email address, and only if Google tells us it is verified. We never use
  it to look you up, and nobody can find you by email in the app;
- your display name and your profile picture URL.

We do **not** keep Google's access or refresh tokens. They are exchanged for
your identity and discarded in the same request.

Your public handle (`@yourname`) is generated from the part of your email
before the `@`, or from your name. It is the only way other people can find you.

**Your birth year.** The year only — never the full date. See *Age* below.

**What you do in the app:**

- your swipes: which title, whether you liked or passed, and when;
- your library: what you marked as interested, watched or discarded, plus any
  1-to-5 rating you gave;
- the genres you picked during onboarding, and a numeric "taste vector" we
  derive from your swipes to order your feed;
- your social graph: friend requests you send and receive, your friendships,
  the titles you and a friend have in common, and your notifications.

**To keep you signed in and to prove consent:**

- a session record: a one-way hash of your refresh token (never the token
  itself), its expiry, and the `User-Agent` string your browser sends;
- a consent record: which version of the in-app notice you accepted, when, and
  the IP address the acceptance came from. The law requires us to be able to
  show this, which is why it is the one place we store an IP on purpose.
- operational logs from the server may record IP address, request path, status
  and timestamp, so that an error in the beta is not invisible. We store none of
  them ourselves: they are written to standard output and live only in our
  hosting provider's rolling log stream, which we do not export, archive or
  search after the fact. Entries age out on the provider's own schedule, and we
  do not extend it.

**What we do not collect:** no full date of birth, no precise location, no
payment data, no phone number, no contact list, no free-text profile, no
behavioural advertising identifiers. The only cookie we set is the one that
holds your sign-in session (`wl_refresh`, `HttpOnly`, `Secure`).

## Why we are allowed to use it (legal basis)

| What | Purpose | Legal basis |
|---|---|---|
| Account, handle, Google identifier, session | Creating your account and keeping you signed in | Performance of a contract — GDPR art. 6(1)(b) / LGPD art. 7º, V |
| Swipes, library, genres, taste vector | Personalising your feed and recommendations (profiling) | **Your consent** — GDPR art. 6(1)(a) / LGPD art. 7º, I |
| Friendships, matches, titles in common | The social features | **Your consent** — GDPR art. 6(1)(a) / LGPD art. 7º, I |
| Birth year | Checking the minimum age the law imposes on us | Legal obligation — GDPR art. 6(1)(c) / LGPD art. 7º, II |
| Session record, consent record, server logs | Security, abuse prevention, keeping the service running | Legitimate interests — GDPR art. 6(1)(f) / LGPD art. 7º, IX |

The consent we rely on for personalisation and for the social graph is
**specific and versioned**: the notice you accept is stored with its version
number. You can withdraw it at any time by deleting your account, which erases
everything at once. Withdrawing consent does not undo processing that already
happened lawfully.

## Age

Watchlytics is for people aged **16 and over**. We ask for your **birth year
and nothing else** — asking for a full date of birth would collect more than we
need to answer the only question we are allowed to ask.

16 is the upper bound of the age range the GDPR leaves to each member state
(13 to 16). We apply one number, the most restrictive, instead of a
country-by-country table we could not keep correct. It also satisfies COPPA,
which protects children under 13 in the United States.

If the year you give us puts you under 16, **we delete the account and keep
nothing**. Signing in with Google had already created a row with your name,
e-mail address and picture; that row is deleted on the spot, and the year you
typed is never stored. Recording "this person tried to sign up and is under age"
would mean keeping exactly the data the law tells us not to collect — and so
would keeping the account itself.

## Who else sees your data

- **Google** — our sign-in provider. Signing in happens on Google's pages,
  under Google's own privacy policy. We send Google nothing about what you
  watch or swipe.
- **TMDB (The Movie Database)** — where our catalogue comes from. Our server
  asks TMDB for titles, posters and cast **without sending any information
  about you**. However, **your browser loads poster and cast images directly
  from TMDB's image CDN**, which means TMDB can see your IP address and which
  images — and therefore which titles — were shown to you. This happens on
  every card you see, and it is the one unavoidable disclosure in the product.
  *This product uses the TMDB API but is not endorsed or certified by TMDB.*
- **Our infrastructure providers**, acting as processors on our instructions:
  Neon (the PostgreSQL database, AWS South America East 1, São Paulo, Brazil),
  Fly.io (the API, region `gru`, São Paulo, Brazil) and Cloudflare Pages (the
  web app and the proxy that keeps everything on one origin, served from a
  global edge network).

  **Your account data is stored in Brazil.** What crosses the border is request
  traffic passing through whichever Cloudflare edge location is nearest to you,
  which can be outside the country. That transfer rests on the standard
  contractual clauses in the provider's data processing agreement (LGPD art. 33,
  and the standard clauses of ANPD Resolução CD/ANPD nº 19/2024).

We do not sell your data, we do not share it for advertising, and we do not
disclose it to anyone else unless a law or a valid legal order requires it.

Other **users** see only your handle, your display name and your picture — plus,
if you turn your profile on, aggregate statistics. They never see your library.
Friends see which titles you and they have in common, which is the point of
the feature. Searching for people works by handle only, never by email, and a
search does not confirm whether an account exists.

## How long we keep it

- **Your account and everything in it:** until you delete it.
- **Deletion is immediate and real.** It cascades through every table — swipes,
  library, friendships, matches, notifications, consent records, sessions. There
  is no soft delete, no grace period and no undo. We do not keep a hidden copy
  of your profile marked "deleted".
- **Sessions:** up to 30 days from sign-in, or until you sign out, whichever
  comes first.
- **Titles you passed on:** eligible to come back into your deck after 180
  days. The swipe itself stays while your account does, because it is what
  stops the same card appearing again tomorrow.
- **Consent records:** for as long as the account exists, as the proof the law
  requires — they are deleted with the account.
- **Server logs:** not retained by us at all — see above. They age out of the
  hosting provider's log stream and we keep no copy.
- **Backups** kept by our infrastructure providers may hold deleted data for a
  short window: our database provider keeps a point-in-time restore window
  measured in days, and data you delete can survive there until that window
  rolls off — after which it is gone. We keep no backups of our own.

## Your rights

Both the LGPD and the GDPR give you these, and two of them work without asking
us, under **"Your data"** in the app:

- **Export** — a JSON file with your profile, swipes, library, friends, matches,
  notifications and consent records (data portability; GDPR art. 20 / LGPD
  art. 18, V).
- **Delete** — erases all of it immediately (GDPR art. 17 / LGPD art. 18, VI).

For the rest, write to keizokita1+watchlytics@gmail.com:
access and confirmation of processing, correction of incomplete or wrong data,
information about who we share data with, withdrawal of consent, objection to
processing, restriction of processing, and review of decisions taken only by
automated means. We answer within the deadlines the applicable law sets.

You can also complain to a regulator without going through us: the **ANPD** in
Brazil, or your national **data protection authority** in the EU/EEA or the UK.

## Profiling

Your feed is ordered by a taste vector derived from your own swipes and the
genres you chose. It decides which cards you see first, and nothing else: it
does not set a price, deny you anything or have any legal effect on you. You
can change the genres at any time, and deleting your account deletes the vector.

## Privacy by default

Your profile is **private when you create it**. Turning it on is an explicit
choice and publishes only aggregate statistics — never your library — and only
once you have marked 10 titles as watched, so that an average cannot be read
backwards into the individual titles behind it.

## Changes to this policy

If we change this policy in a way that matters, we raise the version of the
in-app consent notice. The version recorded against your account is always the
one you accepted, and it is in your data export.

An account keeps the version it accepted. If a change affects how we use data
you have **already** given us, we write to you at the address on your account
and ask you to accept the new version before it applies to you. We do not put a
new basis on old data by publishing a page.

There is no Brazilian-Portuguese version of this policy yet, and that is a
decision rather than an oversight: the beta is invite-only, and everyone in it
reads English. It is not a barrier to your rights — write to the privacy contact
above in Portuguese and you get an answer in Portuguese, and nothing in the
section above depends on which language you read this in. A translated version
comes before the app is open to the public.
