# Rely on provider-managed PostgreSQL storage protection

The Source-First Portfolio Demo uses hosted PostgreSQL, with Supabase PostgreSQL selected for this deployment, and adds neither application-layer or end-to-end encryption nor an application-managed backup workflow. It relies on the provider's mandatory storage protection and accepts the Free plan's unavoidable pause, restore-history, and provider-retention constraints, while acknowledging infrastructure access and possible loss beyond the provider's recovery window; production-grade backup requirements must be reconsidered later.
