# Distribute an open Public Portfolio Release

Tuiscrib will be publicly downloadable through a `v0.1.0` GitHub Release and its binaries will connect to the hosted Tuiscrib Service by default while retaining an explicit service override. CI will build the five platforms already covered by native CI, but the maintainer will upload and publish the release manually. The release will include SHA-256 checksums, while the README will contain one screenshot and a one-minute quick start. The binaries may be unsigned. This decision does not establish an ongoing release cadence or update policy.

Open registration and a frictionless evaluator experience are more important for this student passion project than invitation gating. The existing username, password, and Terminal Session identity model remains unchanged: there is no email verification, password recovery, identity deletion, or data export. The documentation will make those limits explicit and tell users not to store sensitive data.

The hosted Tuiscrib Service on free Render and Supabase plans is a best-effort demonstration. It may sleep, pause, restart, or lose data, with no availability, backup, recovery, or support guarantee. It is not a startup beta or production service.

GitHub Issues is the public problem-reporting channel, with no guaranteed response time or support commitment.

## Considered Options

An invitation-only beta would reduce abuse and operational exposure but would prevent recruiters and evaluators from trying the project without coordination. Requiring source builds or temporary CI artifacts would preserve the developer workflow but would not constitute a credible public distribution path.

## Consequences

Public distribution requires durable release artifacts, clear runtime configuration, checksums, a user-first quick start, and honest limitations. Signing, installers, package-manager channels, account recovery or deletion, application-managed backups, monitoring systems, service guarantees, and business operations remain outside this passion project's launch boundary.
